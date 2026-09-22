"""Root entry point: probe a connector's account label or disconnect it, as the right identities."""

import importlib
import json
import os
import pwd
import resource
import sys

import auth
import connectors
from common import Denied, rpc


def module_for(connector):
    return importlib.import_module(connectors.CONNECTORS[connector].module)


def credential_for(connector):
    """Runs as the connector user: the auth socket returns only that identity's token."""
    spec = connectors.CONNECTORS[connector]
    op = 'access_token' if spec.credential.startswith('google:') else 'token'
    value = rpc('/run/secure-auth/token.sock', {'op': op})
    return value.get('access_token') or value.get('token')


def run_as(user, function):
    """Fork, drop to `user`, run `function`, and return its JSON result to the (root) parent."""
    reader, writer = os.pipe()
    pid = os.fork()
    if pid == 0:
        try:
            os.close(reader)
            account = pwd.getpwnam(user)
            os.setgroups(os.getgrouplist(user, account.pw_gid))
            os.setgid(account.pw_gid)
            os.setuid(account.pw_uid)
            os.umask(0o077)
            payload = json.dumps({'ok': True, 'value': function()})
        except Denied as exc:
            payload = json.dumps({'ok': False, 'error': str(exc)})
        except Exception:
            payload = json.dumps({'ok': False, 'error': 'PROBE_FAILED'})
        os.write(writer, payload.encode())
        os._exit(0)
    os.close(writer)
    with os.fdopen(reader) as stream:
        raw = stream.read(65536)
    os.waitpid(pid, 0)
    value = json.loads(raw) if raw else {'ok': False, 'error': 'PROBE_FAILED'}
    if not value['ok']:
        raise Denied(value['error'])
    return value['value']


def as_auth(function):
    return run_as('secure-auth', function)


def check(connector):
    if connector not in connectors.CONNECTORS:
        raise Denied('UNKNOWN_CONNECTOR')
    return connectors.CONNECTORS[connector]


def probe(connector):
    spec = check(connector)
    label = run_as(spec.user, lambda: module_for(connector).probe(credential_for(connector)))
    as_auth(lambda: auth.set_account(connector, label))
    return {'connector': connector, 'account': label}


def disconnect(connector):
    spec = check(connector)
    if spec.credential.startswith('google:'):
        result = as_auth(lambda: auth.disconnect(connector))
        return {'connector': connector, **result}
    module = module_for(connector)
    revoke = getattr(module, 'revoke', None)
    revoked = False
    if revoke:
        try:
            revoked = bool(run_as(spec.user, lambda: revoke(credential_for(connector))))
        except Denied:
            revoked = False
    as_auth(lambda: auth.remove_token(connector))
    value = {'connector': connector, 'connected': False, 'remote_revoked': revoked}
    if not revoke:
        value['manual_step'] = 'remove the integration in Notion settings'
    return value


def main():
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    if os.getuid() != 0:
        raise Denied('GUEST_ADMIN_REQUIRED')
    connector, action = sys.argv[1], sys.argv[2]
    if action == 'probe':
        print(json.dumps(probe(connector)))
    elif action == 'disconnect':
        print(json.dumps(disconnect(connector)))
    else:
        raise Denied('UNKNOWN_ADMIN_ACTION')


if __name__ == '__main__':
    try:
        main()
    except Denied as exc:
        print(json.dumps({'error': str(exc)}))
        sys.exit(1)
    except Exception:
        print(json.dumps({'error': 'CONNECTOR_ADMIN_FAILED'}))
        sys.exit(1)
