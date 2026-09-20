#!/bin/bash
set -euo pipefail
if ! python3 -c 'import cryptography' 2>/dev/null || ! command -v nft >/dev/null; then
  apt-get update
  apt-get install -y --no-install-recommends python3-cryptography nftables
fi
src=$(cd "$(dirname "$0")" && pwd)
for user in secure-auth secure-gmail secure-inference secure-policy; do
  if ! id "$user" >/dev/null 2>&1; then
    useradd --system --user-group --no-create-home --shell /usr/sbin/nologin "$user"
  fi
done
for group in secure-auth-clients secure-policy-clients; do
  getent group "$group" >/dev/null || groupadd --system "$group"
  usermod -a -G "$group" secure-gmail
  usermod -a -G "$group" secure-inference
done
if ! getent group secure-cell-peer >/dev/null; then
  groupadd --gid 525288 secure-cell-peer
fi
[[ $(getent group secure-cell-peer | cut -d: -f3) == 525288 ]]
install -d -m 0755 /opt/secure-vm/services
install -m 0644 "$src"/services/*.py /opt/secure-vm/services/
install -d -o secure-auth -g secure-auth -m 0700 /var/lib/secure-auth
install -d -o secure-inference -g secure-inference -m 0700 /var/lib/secure-inference
install -d -o secure-policy -g secure-policy -m 0700 /var/lib/secure-policy
cat > /etc/tmpfiles.d/secure-vm.conf <<'EOF'
d /run/secure-auth 0750 secure-auth secure-auth-clients -
d /run/secure-gmail 0750 secure-gmail secure-cell-peer -
d /run/secure-inference 0750 secure-inference secure-cell-peer -
d /run/secure-policy 0750 secure-policy secure-policy-clients -
d /run/secure-vault 0750 root secure-auth -
EOF
systemd-tmpfiles --create /etc/tmpfiles.d/secure-vm.conf
install -m 0644 "$src"/systemd/* /etc/systemd/system/
systemctl daemon-reload
systemctl stop secure-gmail.service secure-auth.service secure-inference.service secure-policy.service
systemctl stop secure-auth.socket secure-gmail.socket secure-inference.socket secure-policy.socket
systemctl enable --now secure-vault-memory.service secure-egress.service secure-egress-refresh.timer
systemctl restart secure-egress.service
# Preserve the user's already-established Gmail read consent only on first migration.
if [[ ! -f /var/lib/secure-policy/policy.sqlite3 ]] && \
   { [[ -f /var/lib/secure-auth/tokens.json ]] || [[ -f /var/lib/secure-auth/tokens.json.enc ]]; }; then
  python3 /opt/secure-vm/services/policy_admin.py gmail-read allow
fi
systemctl enable --now secure-auth.socket secure-gmail.socket secure-inference.socket secure-policy.socket
root=/var/lib/secure-vm/rootfs
install -o 524288 -g 524288 -m 0644 "$src/services/common.py" "$src/gmail-cli.py" "$src/check-gmail.py" "$root/opt/secure-vm/"
install -o 524288 -g 524288 -m 0644 "$src/agent.py" "$src/check-inference.py" "$root/opt/secure-vm/"
install -m 0644 "$src/check-security.py" /opt/secure-vm/check-security.py
echo 'Read-only Gmail and inference services installed; existing credentials/configuration preserved.'
