"""Trusted guest-root CLI. Inputs carrying secrets arrive only through stdin."""

import json
import os
import pwd
import subprocess
import sys
import resource

import auth
from common import Denied

# Actions that change which provider roles are configured: the egress allowlists follow at once
# instead of on the next timer run (a sign-in needs oauth2 before the user is back from Google).
REFRESH_ACTIONS = ('begin', 'complete', 'cancel', 'disconnect', 'import-token')
GOOGLE_ACTIONS = ('begin', 'complete', 'cancel', 'disconnect', 'set-account')


def refresh_egress():
    """Best effort: on failure the timer retries, and services fail closed until it succeeds."""
    try:
        subprocess.run(
            ['systemctl', 'start', 'secure-egress-refresh.service'], capture_output=True, timeout=60, check=False
        )
    except (OSError, subprocess.SubprocessError):
        pass


def main():
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    if os.getuid() != 0:
        raise Denied('GUEST_ADMIN_REQUIRED')
    action = sys.argv[1]
    connector = sys.argv[2] if len(sys.argv) > 2 else 'gmail'
    if connector not in (*auth.GOOGLE, *auth.TOKENS, 'aws'):
        raise Denied('UNKNOWN_CONNECTOR')
    if connector == 'aws' and action not in ('import-aws', 'disconnect', 'status', 'set-account'):
        raise Denied('UNKNOWN_ADMIN_ACTION')
    account = sys.argv[3] if len(sys.argv) > 3 else auth.DEFAULT_ACCOUNT
    if len(sys.argv) > 4 or (len(sys.argv) > 3 and (connector not in auth.GOOGLE or action not in GOOGLE_ACTIONS)):
        raise Denied('UNKNOWN_ADMIN_ACTION')
    auth.account_name(account)
    if action in REFRESH_ACTIONS:
        # The action runs as secure-auth in a child; root stays only to refresh the allowlists.
        pid = os.fork()
        if pid:
            _, status = os.waitpid(pid, 0)
            refresh_egress()
            sys.exit(os.waitstatus_to_exitcode(status))
    identity = pwd.getpwnam('secure-auth')
    os.setgroups([])
    os.setgid(identity.pw_gid)
    os.setuid(identity.pw_uid)
    os.umask(0o077)
    value = {}
    if action in ('import-client', 'begin', 'complete', 'import-token', 'import-aws', 'set-account'):
        data = sys.stdin.buffer.read(16385)
        if len(data) > 16384:
            raise Denied('INPUT_TOO_LARGE')
        value = json.loads(data)
    with auth.locked():
        if action == 'import-client':
            result = auth.import_client(value)
        elif action == 'remove-client':
            result = auth.remove_client()
        elif action == 'begin':
            result = auth.begin(connector, value['redirect_uri'], account)
        elif action == 'complete':
            result = auth.complete(connector, value, account)
        elif action == 'cancel':
            auth.vault.remove(auth.STORE, auth.google_file(connector, 'pending', account))
            result = {'cancelled': True}
        elif action == 'status':
            result = auth.status()
        elif action == 'disconnect' and connector == 'aws':
            result = auth.remove_aws()
        elif action == 'disconnect':
            result = auth.disconnect(connector, account) if connector in auth.GOOGLE else auth.remove_token(connector)
        elif action == 'import-aws' and connector == 'aws':
            result = auth.import_aws(value)
        elif action == 'import-token':
            result = auth.import_token(connector, value)
        elif action == 'set-account':
            result = auth.set_account(connector, value['account'], account)
        else:
            raise Denied('UNKNOWN_ADMIN_ACTION')
    print(json.dumps(result))


if __name__ == '__main__':
    try:
        main()
    except Denied as exc:
        print(json.dumps({'error': str(exc)}))
        sys.exit(1)
    except Exception:
        print(json.dumps({'error': 'ADMIN_OPERATION_FAILED'}))
        sys.exit(1)
