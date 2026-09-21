#!/bin/bash
# Installs every trusted service (auth, policy, inference and all connectors from the registry).
# The file name is kept stable because deployed hosts call it by path.
set -euo pipefail
if ! python3 -c 'import cryptography' 2>/dev/null || ! command -v nft >/dev/null; then
  apt-get update
  apt-get install -y --no-install-recommends python3-cryptography nftables
fi
src=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=guest/cell.env
source "$src/cell.env"
agent_host_uid=$((SECURE_CELL_UID_BASE + SECURE_CELL_AGENT_UID))
registry() { python3 -c "import sys; sys.path.insert(0, '$src/services'); import connectors; print('\n'.join($1))"; }
mapfile -t connector_users < <(registry 'connectors.SERVICE_USERS')
mapfile -t connector_ids < <(registry 'connectors.CONNECTORS')
for user in secure-auth secure-inference secure-policy "${connector_users[@]}"; do
  id "$user" >/dev/null 2>&1 || useradd --system --user-group --no-create-home --shell /usr/sbin/nologin "$user"
done
for group in secure-auth-clients secure-policy-clients; do
  getent group "$group" >/dev/null || groupadd --system "$group"
  for user in secure-inference "${connector_users[@]}"; do usermod -a -G "$group" "$user"; done
done
if ! getent group secure-cell-peer >/dev/null; then
  groupadd --gid "$agent_host_uid" secure-cell-peer
fi
[[ $(getent group secure-cell-peer | cut -d: -f3) == "$agent_host_uid" ]]
install -d -m 0755 /opt/secure-vm/services
install -m 0644 "$src/cell.env" /opt/secure-vm/cell.env
install -m 0644 "$src"/services/*.py /opt/secure-vm/services/
install -d -o secure-auth -g secure-auth -m 0700 /var/lib/secure-auth
install -d -o secure-inference -g secure-inference -m 0700 /var/lib/secure-inference
install -d -o secure-policy -g secure-policy -m 0700 /var/lib/secure-policy
for user in "${connector_users[@]}"; do
  install -d -o "$user" -g "$user" -m 0700 "/var/lib/$user"
done
{
  echo 'd /run/secure-auth 0750 secure-auth secure-auth-clients -'
  echo 'd /run/secure-inference 0750 secure-inference secure-cell-peer -'
  echo 'd /run/secure-policy 0750 secure-policy secure-policy-clients -'
  echo 'd /run/secure-vault 0750 root secure-auth -'
  for id in "${connector_ids[@]}"; do echo "d /run/secure-$id 0750 secure-$id secure-cell-peer -"; done
} > /etc/tmpfiles.d/secure-vm.conf
systemd-tmpfiles --create /etc/tmpfiles.d/secure-vm.conf
install -m 0644 "$src"/systemd/* /etc/systemd/system/
systemctl daemon-reload
units=(secure-auth secure-inference secure-policy)
for id in "${connector_ids[@]}"; do units+=("secure-$id"); done
systemctl stop "${units[@]/%/.service}" 2>/dev/null || true
systemctl stop "${units[@]/%/.socket}" 2>/dev/null || true
systemctl enable --now secure-vault-memory.service secure-egress.service secure-egress-refresh.timer
systemctl restart secure-egress.service
# Preserve the user's already-established Gmail read consent only on first migration.
if [[ ! -f /var/lib/secure-policy/policy.sqlite3 ]] && \
   { [[ -f /var/lib/secure-auth/tokens.json ]] || [[ -f /var/lib/secure-auth/tokens.json.enc ]]; }; then
  python3 /opt/secure-vm/services/policy_admin.py read gmail allow
fi
systemctl enable --now "${units[@]/%/.socket}"
root=/var/lib/secure-vm/rootfs
install -o "$SECURE_CELL_UID_BASE" -g "$SECURE_CELL_UID_BASE" -m 0644 "$src/services/common.py" "$src/gmail-cli.py" "$src/check-gmail.py" "$src/check-connectors.py" "$root/opt/secure-vm/"
install -o "$SECURE_CELL_UID_BASE" -g "$SECURE_CELL_UID_BASE" -m 0644 "$src/agent.py" "$src/check-inference.py" "$root/opt/secure-vm/"
install -m 0644 "$src/check-security.py" /opt/secure-vm/check-security.py
# Version manifest lets the trusted desktop detect guest services older than the app.
printf '{"runtime_version":"%s","installed_at":"%s"}\n' \
  "${SECURE_VM_RUNTIME_VERSION:-unknown}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > /opt/secure-vm/installed.json
chmod 0644 /opt/secure-vm/installed.json
echo 'Trusted services and connectors installed; existing credentials/configuration preserved.'
