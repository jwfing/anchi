"""Trusted guest-root CLI. Inputs carrying secrets arrive only through stdin."""
import json
import os
import pwd
import sys

import auth
from common import Denied

def main():
    if os.getuid() != 0:
        raise Denied('GUEST_ADMIN_REQUIRED')
    account = pwd.getpwnam('secure-auth')
    os.setgroups([])
    os.setgid(account.pw_gid)
    os.setuid(account.pw_uid)
    os.umask(0o077)
    action = sys.argv[1]
    value = {}
    if action in ('import-client', 'begin', 'complete'):
        data = sys.stdin.buffer.read(16385)
        if len(data) > 16384:
            raise Denied('INPUT_TOO_LARGE')
        value = json.loads(data)
    with auth.locked():
        if action == 'import-client':
            result = auth.import_client(value)
        elif action == 'begin':
            result = auth.begin(value['redirect_uri'])
        elif action == 'complete':
            result = auth.complete(value)
        elif action == 'status':
            result = auth.status()
        elif action == 'disconnect':
            result = auth.disconnect()
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
