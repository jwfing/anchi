#!/bin/bash
# Run by the user in their own terminal. Real credentials come only from the
# ANCHI_POC_* variables exported in that terminal; this script never reads
# credential files.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$here/out/mitm"
for v in ANCHI_POC_CLAUDE_TOKEN ANCHI_POC_CODEX_ACCESS_TOKEN ANCHI_POC_CODEX_ACCOUNT_ID \
  ANCHI_POC_GITHUB_TOKEN ANCHI_POC_AWS_ACCESS_KEY_ID ANCHI_POC_AWS_SECRET_ACCESS_KEY; do
  if [[ -n ${!v:-} ]]; then echo "set:     $v"; else echo "missing: $v (matching requests fail closed)"; fi
done
exec "$here/.venv/bin/mitmdump" -q -s "$here/anchi_inject.py" \
  --listen-host 127.0.0.1 --listen-port "${ANCHI_POC_PORT:-18080}" \
  --set confdir="$here/out/mitm"
