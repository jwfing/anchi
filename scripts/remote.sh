#!/bin/bash
# Installs or updates Anchi on a remote server for this computer's `anchi --server <target>`: an
# instabox VM (created when missing) or any Debian or Ubuntu host reached with ssh. It copies this
# checkout, then scripts/server-install.sh there sets up the daemon and anchi-bridge. The guest
# (trusted services, cells, base image) follows from the client: anchi --server <target> setup install.
# --data-dir <path> keeps Anchi's guest data (agents' homes, image layers) on that directory, bind-
# mounted at /var/lib/anchi; an instabox machine uses /data/anchi on its data disk unless told.
set -euo pipefail
cd "$(dirname "$0")/.."
usage() {
  echo 'usage: scripts/remote.sh instabox:<machine> | ssh:<[user@]host> [--data-dir <path>]' >&2
  exit 64
}
target=${1:-}
shift || true
data_dir=
while (($#)); do
  case $1 in
    --data-dir)
      (($# >= 2)) || usage
      data_dir=$2
      shift 2
      ;;
    *) usage ;;
  esac
done
# The names parseServer (anchi/packages/daemon/src/remote.ts) accepts, never an ssh option.
case $target in
  instabox:*)
    name=${target#instabox:}
    [[ $name =~ ^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$ ]] || usage
    ssh=(instabox ssh "$name" --)
    # Ask for JSON: piped, newer instabox CLIs print JSON anyway, which a table parser never matches.
    if ! instabox ls --json | python3 -c 'import json, sys; sys.exit(sys.argv[1] not in {m["name"] for m in json.load(sys.stdin)})' "$name"; then
      # Its own Anchi vault holds the credentials; the instabox Vault's items stay out of it.
      echo "Creating the instabox machine $name (no timeout: it is a server; pause or stop it with instabox)."
      instabox create --name "$name" --no-vault
    fi
    # instabox pauses a machine after 30 idle minutes, and on the free plan after 480 running
    # minutes; a paused server runs no triggers. Turn both off where the plan allows it.
    if instabox auto-suspend "$name" 0 >/dev/null && instabox max-run "$name" -1 >/dev/null; then
      echo "$name stays running: idle pause off, no runtime limit."
    else
      echo "warning: $name still pauses itself (after 30 idle minutes, or 480 running minutes on" >&2
      echo "  the free plan), and runs no triggers while paused. On a paid plan, run:" >&2
      echo "  instabox auto-suspend $name 0 && instabox max-run $name -1" >&2
    fi
    ;;
  ssh:*)
    name=${target#ssh:}
    [[ $name =~ ^[A-Za-z0-9_][A-Za-z0-9._-]*(@[A-Za-z0-9][A-Za-z0-9.-]*)?$ ]] || usage
    ssh=(ssh -T -o BatchMode=yes "$name" --)
    ;;
  *) usage ;;
esac
# The instabox data disk (/data) is the one a user resizes; the root disk stays small.
if [[ -z $data_dir && $target == instabox:* ]]; then data_dir=/data/anchi; fi
# /var/lib/anchi itself means no separate directory. The server checks the rest again.
[[ $data_dir == /var/lib/anchi ]] && data_dir=
if [[ -n $data_dir && ! $data_dir =~ ^/[A-Za-z0-9._/-]+$ ]]; then
  echo 'The --data-dir path must be absolute, of letters, digits, ".", "_", "-" and "/"' >&2
  exit 64
fi
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
if [[ -n $data_dir ]]; then echo "Anchi's data on the server: $data_dir"; fi
"${ssh[@]}" "bash ~/anchi.new/scripts/server-install.sh $data_dir"
echo "Done. In the desktop app, choose Use beside this server (Settings, Server), then Prepare."
echo "From the CLI: anchi server $target; then anchi setup install and anchi setup vault init."
