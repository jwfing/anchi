"""Root-only nftables owner rules and short-lived, public-only provider IP sets."""

import fcntl
import ipaddress
import json
import os
from pathlib import Path
import pwd
import socket
import subprocess
import sys
import time

from common import CELL_AGENT_HOST_UID
import connectors

TARGETS = Path('/run/secure-egress/targets.json')
# role -> (service user, single allowed host). Connector roles come from the registry.
ROLES = {
    'auth': ('secure-auth', 'oauth2.googleapis.com'),
    'model': ('secure-inference', 'api.openai.com'),
    'codex': ('secure-inference', 'chatgpt.com'),
    **{c.id: (c.user, c.hosts[0]) for c in connectors.CONNECTORS.values()},
}


def nft(text):
    subprocess.run(['/usr/sbin/nft', '-f', '-'], input=text, text=True, check=True, capture_output=True)


def initialize():
    present = (
        subprocess.run(['/usr/sbin/nft', 'list', 'table', 'inet', 'secure_vm'], capture_output=True).returncode == 0
    )
    lines = ['delete table inet secure_vm'] if present else []
    lines += ['table inet secure_vm {']
    for role in ROLES:
        for version, datatype in ((4, 'ipv4_addr'), (6, 'ipv6_addr')):
            lines.append(f' set {role}{version} {{ type {datatype}; flags timeout; timeout 5m; }}')
    lines.append(' chain output { type filter hook output priority -10; policy accept;')
    # A service may have more than one provider: put all allow rules before its reject.
    users = dict.fromkeys(user for user, _ in ROLES.values())
    for user in users:
        uid = pwd.getpwnam(user).pw_uid
        for role, (owner, _) in ROLES.items():
            if owner != user:
                continue
            lines.append(f'  meta skuid {uid} ip daddr @{role}4 tcp dport 443 accept')
            lines.append(f'  meta skuid {uid} ip6 daddr @{role}6 tcp dport 443 accept')
        lines.append(f'  meta skuid {uid} counter reject')
    # The policy engine must never create IP traffic, even outside its service unit.
    lines.append(f'  meta skuid {pwd.getpwnam("secure-policy").pw_uid} counter reject')
    lines.append(f'  meta skuid {CELL_AGENT_HOST_UID} counter reject')
    lines += [' }', '}']
    nft('\n'.join(lines))


def refresh():
    result, commands = {}, []
    for role, (_, host) in ROLES.items():
        addresses = sorted({a[4][0] for a in socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)})
        if not addresses or any(not ipaddress.ip_address(a).is_global for a in addresses):
            raise RuntimeError('Provider DNS returned a non-public address')
        result[host] = {'addresses': addresses, 'expires_at': time.time() + 240}
        for version in (4, 6):
            values = [a for a in addresses if ipaddress.ip_address(a).version == version]
            commands.append(f'flush set inet secure_vm {role}{version}')
            if values:
                commands.append(
                    f'add element inet secure_vm {role}{version} {{ '
                    + ', '.join(a + ' timeout 5m' for a in values)
                    + ' }'
                )
    # One atomic nft transaction; failed resolution does not install partial broad rules.
    nft('\n'.join(commands))
    temporary = TARGETS.with_suffix('.new')
    fd = os.open(temporary, os.O_WRONLY | os.O_TRUNC | os.O_CREAT, 0o644)
    with os.fdopen(fd, 'w') as file:
        json.dump(result, file)
    os.replace(temporary, TARGETS)


def main():
    if os.getuid() != 0:
        raise SystemExit('Root required')
    TARGETS.parent.mkdir(mode=0o755, exist_ok=True)
    with (TARGETS.parent / 'update.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if sys.argv[1] == 'init':
            initialize()
        elif sys.argv[1] != 'refresh':
            raise SystemExit('Unknown action')
        refresh()
    print('Provider address sets updated; service DNS/direct destinations remain restricted.')


if __name__ == '__main__':
    main()
