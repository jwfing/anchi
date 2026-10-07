#!/bin/bash
# Guest root. Starts the PoC proxy with FAKE credentials, runs the in-cell
# checks, measures cell start-up variants, then stops everything it started.
set -euo pipefail
[[ $(id -u) == 0 ]] || { echo 'run as guest root' >&2; exit 1; }
# shellcheck source=/dev/null
source /opt/secure-vm/cell.env
rootfs=/var/lib/secure-vm/rootfs
run=/run/anchi-poc

cleanup() {
  systemctl stop anchi-poc-proxy anchi-poc-bridge 2>/dev/null || true
  rm -rf "$run"
}
trap cleanup EXIT
cleanup
install -d -m 0755 "$run"

# Proxy and bridge run as the dedicated anchi-poc user with fake credentials.
systemd-run --quiet --unit=anchi-poc-proxy --uid=anchi-poc --gid=anchi-poc \
  --setenv=ANCHI_POC_GITHUB_TOKEN=fake-not-real \
  --setenv=ANCHI_POC_LOG=/opt/anchi-poc/state/flows.jsonl \
  /opt/anchi-poc/venv/bin/mitmdump -q -s /opt/anchi-poc/anchi_inject.py \
  --listen-host 127.0.0.1 --listen-port 18080 --set confdir=/opt/anchi-poc/state/mitm
chown anchi-poc:anchi-poc "$run"
systemd-run --quiet --unit=anchi-poc-bridge --uid=anchi-poc --gid=anchi-poc \
  /usr/bin/python3 /opt/anchi-poc/fwd.py unix-to-tcp "$run/proxy.sock" 127.0.0.1 18080
for _ in $(seq 1 60); do
  [[ -S $run/proxy.sock && -f /opt/anchi-poc/state/mitm/mitmproxy-ca-cert.pem ]] && break
  sleep 0.5
done
install -m 0644 /opt/anchi-poc/state/mitm/mitmproxy-ca-cert.pem "$run/ca.pem"
install -m 0644 /opt/anchi-poc/fwd.py /opt/anchi-poc/cell_client.py "$run/"
since=$(date +%s)

# Same isolation flags as guest/cell-run, minus the connector sockets, plus
# the PoC socket directory. The cell keeps --private-network: loopback only.
nspawn_base=(/usr/bin/systemd-nspawn --quiet --register=no --settings=no
  --directory="$rootfs"
  --private-users="$SECURE_CELL_UID_BASE:$SECURE_CELL_UID_COUNT" --private-users-ownership=off
  --private-network --user=agent --drop-capability=all --no-new-privileges=yes
  --console=pipe --tmpfs=/tmp:mode=1777,size=64M
  --bind-ro="$run":"$run" --setenv=HOME=/tmp --setenv=PATH=/usr/bin:/bin)

echo "== in-cell network checks (read-only rootfs, --private-network)"
"${nspawn_base[@]}" --read-only --machine=anchi-poc-cell -- /bin/sh -c \
  "python3 $run/fwd.py tcp-to-unix 3128 $run/proxy.sock >/dev/null & sleep 0.5; python3 $run/cell_client.py"

echo "== proxy log for the in-cell run"
python3 - "$since" <<'EOF'
import json, sys
since = float(sys.argv[1])
for line in open("/opt/anchi-poc/state/flows.jsonl"):
    r = json.loads(line)
    if r.get("ts", 0) >= since:
        print(f'  {r.get("decision", r.get("event")):<12} client={r.get("client_cred","-"):<11} {r.get("host")} {r.get("op", r.get("path"))}')
EOF

time_cell() {
  local label=$1; shift
  local samples=()
  for _ in 1 2 3 4 5; do
    local t0 t1
    t0=$(date +%s%N)
    "${nspawn_base[@]}" "$@" --machine="anchi-poc-t$RANDOM" -- /bin/true
    t1=$(date +%s%N)
    samples+=($(( (t1 - t0) / 1000000 )))
  done
  echo "  $label: ${samples[*]} ms"
}

echo "== cell start-up to /bin/true exit (5 samples each)"
time_cell "read-only shared rootfs (current)" --read-only
time_cell "volatile overlay (tmpfs upper, discarded)" --volatile=overlay
echo "  ephemeral full copy (ext4, no reflink):"
t0=$(date +%s%N)
"${nspawn_base[@]}" --ephemeral --machine=anchi-poc-eph -- /bin/true
echo "    $(( ($(date +%s%N) - t0) / 1000000 )) ms (1 sample)"

echo "== writable layer check under --volatile=overlay"
# Cell root (no capabilities) owns /etc in the shifted rootfs, so it can write
# there; the agent user cannot write anywhere outside /tmp.
overlay_cell=("${nspawn_base[@]/--user=agent/--user=root}")
"${overlay_cell[@]}" --volatile=overlay --machine=anchi-poc-w1 -- /bin/sh -c \
  'echo x > /etc/anchi-poc-write && echo "  write inside cell: ok"'
[[ -e $rootfs/etc/anchi-poc-write ]] && echo "  LEAKED into shared rootfs" || echo "  shared rootfs unchanged: ok"
"${overlay_cell[@]}" --volatile=overlay --machine=anchi-poc-w2 -- /bin/sh -c \
  '[ -e /etc/anchi-poc-write ] && echo "  visible in next cell: LEAK" || echo "  next cell clean: ok"'
