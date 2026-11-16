#!/bin/bash
# Installs the host placement's Python side: a venv under ~/.anchi/host with the mitmproxy and
# botocore the egress proxy is pinned to (guest/cell.env), on this computer's own Python 3.11+.
# No VM, no root, nothing outside $ANCHI_HOME. The daemon starts the proxy and the vault's auth
# service from here (anchi/packages/daemon/src/host-placement.ts). Run again to update.
set -euo pipefail
cd "$(dirname "$0")/.."
home=${ANCHI_HOME:-$HOME/.anchi}
root=$home/host
venv=$root/venv
# shellcheck source=guest/cell.env
source guest/cell.env

python=""
for candidate in python3.14 python3.13 python3.12 python3.11 python3; do
  if command -v "$candidate" >/dev/null 2>&1 &&
    "$candidate" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)' 2>/dev/null; then
    python=$(command -v "$candidate")
    break
  fi
done
[[ -n $python ]] || { echo 'Python 3.11 or newer is required (python3 on PATH)' >&2; exit 1; }
"$python" -c 'import venv, ensurepip' 2>/dev/null || { echo "$python lacks the venv module" >&2; exit 1; }

mkdir -p "$root" "$root/state" "$root/bin"
chmod 0700 "$root" "$root/state"
have=$("$venv/bin/python" -c 'import mitmproxy.version as m, botocore; print(m.VERSION, botocore.__version__)' 2>/dev/null || true)
if [[ $have != "$ANCHI_MITMPROXY_VERSION $ANCHI_BOTOCORE_VERSION" ]]; then
  echo "Installing mitmproxy $ANCHI_MITMPROXY_VERSION and botocore $ANCHI_BOTOCORE_VERSION into $venv"
  rm -rf "$venv"
  "$python" -m venv "$venv"
  "$venv/bin/python" -m pip install --quiet --disable-pip-version-check \
    "mitmproxy==$ANCHI_MITMPROXY_VERSION" "botocore==$ANCHI_BOTOCORE_VERSION"
fi
version=$(node -p 'require("./anchi/package.json").version' 2>/dev/null || sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' manifest.json | head -1)
printf '{"version": "%s", "installed_at": %s}\n' "${version:-unknown}" "$(date +%s)" >"$root/installed.json.new"
mv "$root/installed.json.new" "$root/installed.json"
echo "Host placement installed under $root (Python: $python). Next: anchi setup vault init, then anchi host enable."
