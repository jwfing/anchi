#!/bin/bash
# Live check of the host placement on this computer: with the daemon running as ANCHI_GUEST=host,
# the proxy up and `anchi host enable` done, runs the probes of the spike through a real
# `claude -p` or `codex exec` session (each calls a model with your account) and checks that
# the proxy saw the requests and that the bypasses failed. Explicit, never part of `make check`.
#   scripts/verify-host.sh [claude|codex|both]
set -euo pipefail
cd "$(dirname "$0")/.."
which=${1:-both}
home=${ANCHI_HOME:-$HOME/.anchi}
host=$home/host
audit=$host/audit.jsonl
bin=$host/bin
[[ -x $bin/claude || -x $bin/codex ]] || { echo 'run `anchi host enable` first' >&2; exit 1; }
[[ -S $host/state/run/control.sock ]] || { echo 'the proxy is not running (anchi host status)' >&2; exit 1; }
export PATH=$bin:$PATH
work=$(mktemp -d "${TMPDIR:-/tmp}/anchi-verify-host.XXXXXX")
trap 'rm -rf "$work"' EXIT
prompt='Run each of the following shell commands exactly as written, one shell call per command, in this order. Do not modify, combine or retry them, and never run anything outside the sandbox. Then print one line per command: its number, its exit code, and the first 200 characters of its output.
1. curl -sS -m 20 https://api.github.com/zen
2. curl -sS -m 10 --noproxy "*" https://api.github.com/zen
3. python3 -c "import socket; socket.create_connection((\"1.1.1.1\", 443), timeout=5); print(\"raw socket connected\")"
4. ls -la ~/.ssh
5. echo "token=$GH_TOKEN"'
fail=0
check() {
  local name=$1 output=$2
  if grep -q 'raw socket connected' <<<"$output"; then echo "FAIL $name: a raw socket reached the network"; fail=1; fi
  if grep -qE 'id_(rsa|ed25519)' <<<"$output"; then echo "FAIL $name: ~/.ssh was readable"; fail=1; fi
  if grep -q 'token=gh' <<<"$output"; then echo "FAIL $name: a real token was in the environment"; fail=1; fi
  if ! grep -q 'token=anchi-placeholder' <<<"$output"; then echo "WARN $name: no placeholder in the environment (GitHub not connected, or the shim is not first on PATH)"; fi
  if ! grep -q '"host": "api.github.com"' <(tail -n 200 "$audit" 2>/dev/null); then echo "FAIL $name: the proxy audit has no api.github.com request"; fail=1; fi
}
before=$(wc -l <"$audit" 2>/dev/null || echo 0)
if [[ $which == claude || $which == both ]]; then
  echo '== claude -p'
  out=$(cd "$work" && claude -p --max-turns 12 --output-format text "$prompt" 2>&1 || true)
  printf '%s\n' "$out" | tail -n 12
  check claude "$out"
fi
if [[ $which == codex || $which == both ]]; then
  echo '== codex exec'
  out=$(cd "$work" && codex exec --skip-git-repo-check "$prompt" 2>&1 || true)
  printf '%s\n' "$out" | tail -n 12
  check codex "$out"
fi
after=$(wc -l <"$audit" 2>/dev/null || echo 0)
echo "audit rows added: $((after - before)) ($audit)"
if ((fail)); then echo 'verify-host: FAILED'; exit 1; fi
echo 'verify-host: OK'
