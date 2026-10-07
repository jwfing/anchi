#!/bin/sh
# Runs inside the task cell as the agent user. Holds placeholders only.
set -u
RUN=/run/anchi-poc
. /etc/profile.d/anchi-proxy.sh

echo "== whoami: $(id -un) uid=$(id -u)"
echo "== git through proxy (public repo, ls-remote + shallow clone)"
git ls-remote "https://github.com/$ANCHI_POC_REPO.git" HEAD 2>&1 | tail -2
t0=$(date +%s)
git clone -q --depth 1 "git@github.com:$ANCHI_POC_REPO.git" /home/agent/repo 2>&1 | tail -2 &&
  echo "   clone ok in $(( $(date +%s) - t0 )) s: $(git -C /home/agent/repo log --oneline -1 | cut -c1-60)"

echo "== codex exec with placeholder auth.json"
export CODEX_HOME=/home/agent/.codex
python3 "$RUN/make_placeholders.py" codex "$CODEX_HOME"
echo "   sandbox mode: $ANCHI_POC_SANDBOX"
cd /home/agent/repo 2>/dev/null || cd /home/agent
timeout 240 codex exec --skip-git-repo-check --sandbox "$ANCHI_POC_SANDBOX" "$ANCHI_POC_PROMPT" </dev/null 2>&1 | tail -40
echo "== report.txt written by Codex:"
cat report.txt 2>/dev/null || echo "   (missing)"
[ -e /etc/anchi-probe ] && echo "== /etc/anchi-probe EXISTS" || echo "== /etc/anchi-probe absent"
