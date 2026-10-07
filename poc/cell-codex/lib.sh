# shellcheck shell=bash
# Shared guest-root helpers: PoC proxy lifecycle and cell flags.
# shellcheck source=/dev/null
source /opt/secure-vm/cell.env
BASE=/var/lib/secure-vm/rootfs
POC=/var/lib/anchi-poc
RUN=/run/anchi-poc
CA_SRC=/opt/anchi-poc/state/mitm/mitmproxy-ca-cert.pem

# Starts mitmdump + bridge as anchi-poc. Real credentials are only taken from
# ANCHI_POC_* variables present in this script's environment (the user
# supplies them); otherwise the GitHub/Codex rules get fake values.
proxy_up() {
  proxy_down
  install -d -o anchi-poc -g anchi-poc -m 0755 "$RUN"
  local envs=(--setenv=ANCHI_POC_LOG=/opt/anchi-poc/state/flows.jsonl)
  local v
  for v in ANCHI_POC_CLAUDE_TOKEN ANCHI_POC_CODEX_ACCESS_TOKEN ANCHI_POC_CODEX_ACCOUNT_ID \
    ANCHI_POC_GITHUB_TOKEN ANCHI_POC_AWS_ACCESS_KEY_ID ANCHI_POC_AWS_SECRET_ACCESS_KEY; do
    if [[ -n ${!v:-} ]]; then
      envs+=("--setenv=$v=${!v}")
      echo "proxy: $v from caller"
    fi
  done
  [[ -n ${ANCHI_POC_GITHUB_TOKEN:-} ]] || envs+=(--setenv=ANCHI_POC_GITHUB_TOKEN=fake-not-real)
  [[ -n ${ANCHI_POC_CODEX_ACCESS_TOKEN:-} ]] || envs+=(--setenv=ANCHI_POC_CODEX_ACCESS_TOKEN=fake-not-real
    --setenv=ANCHI_POC_CODEX_ACCOUNT_ID=fake-not-real)
  systemd-run --quiet --unit=anchi-poc-proxy --uid=anchi-poc --gid=anchi-poc "${envs[@]}" \
    /opt/anchi-poc/venv/bin/mitmdump -q -s /opt/anchi-poc/anchi_inject.py \
    --listen-host 127.0.0.1 --listen-port 18080 --set confdir=/opt/anchi-poc/state/mitm
  systemd-run --quiet --unit=anchi-poc-bridge --uid=anchi-poc --gid=anchi-poc \
    /usr/bin/python3 /opt/anchi-poc/fwd.py unix-to-tcp "$RUN/proxy.sock" 127.0.0.1 18080
  local _
  for _ in $(seq 1 60); do
    [[ -S $RUN/proxy.sock && -f $CA_SRC ]] && ss -ltn | grep -q 127.0.0.1:18080 && break
    sleep 0.5
  done
  install -m 0644 "$CA_SRC" "$RUN/ca.pem"
  install -m 0644 /opt/anchi-poc/fwd.py "$RUN/"
  date +%s >"$RUN/since"
}

proxy_down() {
  systemctl stop anchi-poc-proxy anchi-poc-bridge 2>/dev/null || true
  rm -rf "$RUN"
}

proxy_log() {
  python3 - "$(cat "$RUN/since")" <<'EOF'
import collections, json, sys
since = float(sys.argv[1])
rows = [json.loads(l) for l in open("/opt/anchi-poc/state/flows.jsonl")]
c = collections.Counter(
    (r.get("decision", r.get("event")), r.get("client_cred", "-"), r.get("host"), r.get("op", r.get("path")))
    for r in rows if r.get("ts", 0) >= since)
for (d, cred, host, op), n in sorted(c.items(), key=str):
    print(f"  {n:4} {d:<19} client={cred:<11} {host} {op}")
EOF
}

# Isolation flags shared with guest/cell-run. The cell keeps
# --private-network and reaches the proxy only through $RUN/proxy.sock.
cell_flags() {
  local dir=$1
  CELL=(/usr/bin/systemd-nspawn --quiet --register=no --settings=no --directory="$dir"
    --private-users="$SECURE_CELL_UID_BASE:$SECURE_CELL_UID_COUNT" --private-users-ownership=off
    --private-network --no-new-privileges=yes --console=pipe
    --bind-ro="$RUN:$RUN" --setenv=PATH=/usr/local/bin:/usr/bin:/bin:/opt/node/bin)
}

# Cell-side forwarder prefix: 127.0.0.1:3128 -> proxy socket.
FWD="python3 $RUN/fwd.py tcp-to-unix 3128 $RUN/proxy.sock >/dev/null 2>&1 & sleep 0.5;"
