#!/bin/bash
# Guest root. Installs the PoC proxy under /opt/anchi-poc with its own user.
# Does not touch existing secure-vm services, rootfs or nftables.
set -euo pipefail
[[ $(id -u) == 0 ]] || { echo 'run as guest root' >&2; exit 1; }
src=${1:?usage: vm-setup.sh SRC_DIR}
id anchi-poc >/dev/null 2>&1 || useradd --system --home-dir /opt/anchi-poc --shell /usr/sbin/nologin anchi-poc
install -d -o root -g root -m 0755 /opt/anchi-poc
install -m 0644 "$src/anchi_inject.py" "$src/fwd.py" "$src/cell_client.py" /opt/anchi-poc/
if [[ ! -x /opt/anchi-poc/venv/bin/mitmdump ]]; then
  dpkg -s python3-venv >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq python3-venv >/dev/null; }
  python3 -m venv /opt/anchi-poc/venv
  /opt/anchi-poc/venv/bin/pip install -q mitmproxy botocore
fi
install -d -o anchi-poc -g anchi-poc -m 0700 /opt/anchi-poc/state
/opt/anchi-poc/venv/bin/mitmdump --version | head -1
