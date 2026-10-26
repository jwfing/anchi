#!/bin/bash
# Runs on a remote server from the copy scripts/remote.sh made in ~/anchi.new: moves it to
# ~/anchi, installs its packages, anchi-bridge, and the daemon as a systemd user unit that drives
# this machine as its guest (ANCHI_GUEST=local) and keeps running without a login session.
# With a directory argument, Anchi's guest data moves there (guest/anchi_data_dir.py).
set -euo pipefail
data_dir=${1:-}
new=$HOME/anchi.new
dest=$HOME/anchi
cd "$new"
# shellcheck source=guest/arch.sh
source guest/arch.sh
export ANCHI_GUEST=local
node_major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
((node_major >= 22)) || { echo 'This server needs Node.js 22 or newer' >&2; exit 1; }
sudo -n true 2>/dev/null || { echo 'This server needs passwordless sudo for its login user' >&2; exit 1; }
# Restarting the daemon ends every cell: refuse while tasks run, as installing the guest does.
if command -v anchi-cell >/dev/null; then refuse_if_tasks_running local; fi
# The pnpm version anchi/package.json pins, through a corepack shim in ~/.local/bin rather than a
# global install; the daemon's PATH keeps it for install-anchi.sh, which bundles the cell runner.
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
mkdir -p "$HOME/.local/bin"
corepack enable --install-directory "$HOME/.local/bin" pnpm
export PATH=$HOME/.local/bin:$PATH
(cd anchi && pnpm install --frozen-lockfile >/dev/null)
rm -rf "$dest.old"
if [[ -d $dest ]]; then mv "$dest" "$dest.old"; fi
mv "$new" "$dest"
rm -rf "$dest.old"
sudo -n install -m 0755 "$dest/scripts/anchi-bridge.py" /usr/local/bin/anchi-bridge
# A user manager that runs from boot, not only while someone is logged in.
sudo -n loginctl enable-linger "$USER"
XDG_RUNTIME_DIR=/run/user/$(id -u)
export XDG_RUNTIME_DIR
for _ in $(seq 50); do [[ -S $XDG_RUNTIME_DIR/bus ]] && break; sleep 0.2; done
if [[ -n $data_dir ]]; then
  # Cells use the data: stop the daemon, which ends them, and clear what they left. The restart
  # below starts it again.
  systemctl --user stop anchi-daemon.service 2>/dev/null || true
  if command -v anchi-cell >/dev/null; then sudo -n anchi-cell reap >/dev/null || true; fi
  sudo -n python3 "$dest/guest/anchi_data_dir.py" "$data_dir" --home "$HOME"
fi
"$dest/scripts/anchi" daemon install
systemctl --user restart anchi-daemon.service
echo "Anchi daemon running on $(hostname) (guest: this machine)."
