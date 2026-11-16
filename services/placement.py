"""Where the trusted services keep state and sockets.

In the VM every service has its own user and fixed paths under /var/lib and /run, and the admin
scripts run as root. On a host placement (no VM: the daemon, the proxy and these services run as
the user, next to the user's own Claude Code or Codex) `ANCHI_HOST_STATE` names one directory,
mode 0700, that takes the place of all of them, and there is no root and no other user. What
keeps a session away from that directory is its sandbox, not the kernel's users.
"""

import os
from pathlib import Path

HOST_STATE = os.environ.get('ANCHI_HOST_STATE')
HOST = HOST_STATE is not None
ROOT = Path(HOST_STATE) if HOST else None


def path(vm_path, host_relative):
    """The VM's fixed path, or `host_relative` under the host state directory."""
    return ROOT / host_relative if HOST else Path(vm_path)


def admin_allowed():
    """Guest administration is root's in the VM; on the host it is the user's own."""
    return HOST or os.getuid() == 0


def auth_socket(role):
    """The auth service's socket for one caller role: the single socket in the VM (the kernel
    UID names the caller), one per role on the host (the socket names the caller)."""
    return str(ROOT / 'run' / f'auth-{role}.sock') if HOST else '/run/secure-auth/token.sock'
