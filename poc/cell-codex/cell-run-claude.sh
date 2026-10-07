#!/bin/sh
# Runs inside the task cell as the agent user. Holds a placeholder token only.
set -u
. /etc/profile.d/anchi-proxy.sh
export PATH=/usr/local/bin:/usr/bin:/bin:/opt/node/bin
export CLAUDE_CODE_OAUTH_TOKEN="sk-ant-oat01-anchi-placeholder-0000000000000000000000000000000000000000"
unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN
cd /home/agent

echo "== whoami: $(id -un); $(claude --version 2>&1 | head -1)"
echo "== claude -p (plain reply)"
timeout 120 claude -p "Reply with exactly: hi" </dev/null 2>&1 | tail -8
echo "   exit: $?"

echo "== claude -p (tool use, permissions skipped; the cell is the boundary)"
timeout 180 claude -p 'Use the Bash tool to run "uname -m" and "ls / | head -5", write both outputs to report.txt in the current directory, then try to create /etc/anchi-probe and say whether it worked. End with: DONE' \
  --dangerously-skip-permissions </dev/null 2>&1 | tail -12
echo "   exit: $?"
echo "== report.txt:"; cat report.txt 2>/dev/null || echo "   (missing)"
[ -e /etc/anchi-probe ] && echo "== /etc/anchi-probe EXISTS" || echo "== /etc/anchi-probe absent"
