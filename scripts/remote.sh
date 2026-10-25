#!/bin/bash
# Installs or updates Anchi on a remote server for this computer's `anchi --server <target>`: an
# instabox VM (created when missing) or any Debian or Ubuntu host reached with ssh. It copies this
# checkout, then scripts/server-install.sh there sets up the daemon and anchi-bridge. The guest
# (trusted services, cells, base image) follows from the client: anchi --server <target> setup install.
set -euo pipefail
cd "$(dirname "$0")/.."
usage() {
  echo 'usage: scripts/remote.sh instabox:<machine> | ssh:<[user@]host>' >&2
  exit 64
}
target=${1:-}
# The names parseServer (anchi/packages/daemon/src/remote.ts) accepts, never an ssh option.
case $target in
  instabox:*)
    name=${target#instabox:}
    [[ $name =~ ^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$ ]] || usage
    ssh=(instabox ssh "$name" --)
    if ! instabox ls | awk -v n="$name" 'NR > 1 && $1 == n { found = 1 } END { exit !found }'; then
      # Its own Anchi vault holds the credentials; the instabox Vault's items stay out of it.
      echo "Creating the instabox machine $name (no timeout: it is a server; pause or stop it with instabox)."
      instabox create --name "$name" --no-vault
    fi
    ;;
  ssh:*)
    name=${target#ssh:}
    [[ $name =~ ^[A-Za-z0-9_][A-Za-z0-9._-]*(@[A-Za-z0-9][A-Za-z0-9.-]*)?$ ]] || usage
    ssh=(ssh -T -o BatchMode=yes "$name" --)
    ;;
  *) usage ;;
esac
command -v pnpm >/dev/null || { echo 'pnpm is required to bundle the cell runner' >&2; exit 1; }
(cd anchi && pnpm --dir packages/cell-runner run bundle >/dev/null)
# Tracked and new files of the parts a server runs, plus the bundled runner; never node_modules,
# artifacts or anything .gitignore keeps out.
files=$(mktemp)
trap 'rm -f "$files"' EXIT
git ls-files -co --exclude-standard -- anchi guest services systemd scripts lima Makefile >"$files"
ls anchi/packages/cell-runner/dist/{runner,forward,mcp}.mjs >>"$files"
echo "Copying this checkout to $target"
COPYFILE_DISABLE=1 tar czf - --no-xattrs -T "$files" |
  "${ssh[@]}" 'rm -rf ~/anchi.new && mkdir -p ~/anchi.new && tar xzf - -C ~/anchi.new 2>/dev/null'
"${ssh[@]}" 'bash ~/anchi.new/scripts/server-install.sh'
echo "Done. In the desktop app, choose Use beside this server (Settings, Server), then Prepare."
echo "From the CLI: anchi server $target; then anchi setup install and anchi setup vault init."
