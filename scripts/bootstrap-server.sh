#!/bin/bash
# First-time remote setup from the desktop's bundled resources. The public installer verifies
# the matching release archive; neither a checkout nor a Node installation is needed remotely.
set -euo pipefail
version=${1:-}
data_dir=${2:-}
[[ $version =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || { echo 'Invalid release version' >&2; exit 64; }
[[ $data_dir == /data/anchi || $data_dir == /var/lib/anchi ]] || { echo 'Invalid data directory' >&2; exit 64; }
[[ $(uname -s)-$(uname -m) == Linux-x86_64 ]] || { echo 'Desktop initialization needs Linux x86_64; use scripts/remote.sh from a checkout for other supported servers.' >&2; exit 1; }
resources=$(cd "$(dirname "$0")" && pwd)
for tool in curl tar python3 sudo systemctl loginctl flock; do
  command -v "$tool" >/dev/null || { echo "This server needs $tool" >&2; exit 1; }
done
python3 -c 'import sys; sys.exit(sys.version_info < (3, 11))' || { echo 'This server needs Python 3.11+' >&2; exit 1; }
sudo -n true || { echo 'This server needs passwordless sudo' >&2; exit 1; }
# Do not turn a damaged installation into an upgrade or interrupt an existing daemon's tasks.
if command -v anchi-bridge >/dev/null; then
  echo 'Anchi is already initialized; reconnect to it.'
  exit 0
fi
if command -v anchi-cell >/dev/null; then
  echo 'Guest services already exist; repair the missing bridge with scripts/remote.sh after tasks finish.' >&2
  exit 1
fi
mkdir -p "$HOME/.local/share/anchi"
exec 9>"$HOME/.local/share/anchi/.bootstrap-lock"
flock -n 9 || { echo 'Remote initialization is already running' >&2; exit 1; }
pending=$HOME/.local/share/anchi/.bootstrap-pending
if [[ -e ${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/anchi-daemon.service ]] && [[ ! -f $pending ]]; then
  echo 'Anchi is already configured here but its bridge is missing. Repair it with scripts/remote.sh after tasks finish.' >&2
  exit 1
fi
[[ ! -e /usr/local/bin/anchi-bridge && ! -L /usr/local/bin/anchi-bridge ]] || { echo 'An existing /usr/local/bin/anchi-bridge is not on PATH; fix PATH before initialization.' >&2; exit 1; }
if [[ -f $pending ]] && [[ $(cat "$pending") != "$version" ]]; then
  echo 'Resume the interrupted initialization with the same app version.' >&2
  exit 1
fi
printf '%s\n' "$version" > "$pending.tmp"
mv "$pending.tmp" "$pending"
echo "Installing Anchi $version"
ANCHI_VERSION=v$version ANCHI_DESKTOP=0 ANCHI_BIN_DIR="$HOME/.local/bin" \
  ANCHI_INSTALL_ROOT="$HOME/.local/share/anchi" sh "$resources/install.sh"
export PATH=$HOME/.local/bin:$PATH
if [[ $data_dir == /data/anchi ]]; then
  sudo -n python3 "$resources/anchi_data_dir.py" "$data_dir" --home "$HOME"
fi
sudo -n loginctl enable-linger "$(id -un)"
XDG_RUNTIME_DIR=/run/user/$(id -u)
export XDG_RUNTIME_DIR
for _ in $(seq 50); do [[ -S $XDG_RUNTIME_DIR/bus ]] && break; sleep 0.2; done
echo 'Starting the Anchi daemon'
ANCHI_GUEST=local "$HOME/.local/bin/anchi" --server local daemon install
systemctl --user is-active --quiet anchi-daemon.service
# Install the bridge last: an interrupted bootstrap can be retried without claiming success.
sudo -n install -m 0755 "$resources/anchi-bridge.py" /usr/local/bin/anchi-bridge
rm "$pending"
echo 'Anchi is ready to connect. Continue with environment setup.'
