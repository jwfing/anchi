#!/bin/sh
# Runs inside the task cell as the agent user. Holds placeholders only.
set -u
RUN=/run/anchi-poc
. /etc/profile.d/anchi-proxy.sh
mkdir -p "$HOME"

echo "== whoami: $(id -un) uid=$(id -u)"
echo "== git through proxy (public repo, ls-remote + shallow clone)"
git ls-remote "https://github.com/$ANCHI_POC_REPO.git" HEAD 2>&1 | tail -2
t0=$(date +%s)
git clone -q --depth 1 "git@github.com:$ANCHI_POC_REPO.git" /tmp/home/repo 2>&1 | tail -2 &&
  echo "   clone ok in $(( $(date +%s) - t0 )) s: $(git -C /tmp/home/repo log --oneline -1 | cut -c1-60)"

echo "== codex exec with placeholder auth.json"
export CODEX_HOME=/tmp/home/.codex
python3 "$RUN/make_placeholders.py" codex "$CODEX_HOME"
cd /tmp/home && timeout 120 codex exec --skip-git-repo-check --sandbox read-only "$ANCHI_POC_PROMPT" </dev/null 2>&1 | tail -25
echo "== codex exit: $?"
