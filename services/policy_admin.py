"""Independent human/admin entry point, never exposed to the runtime cell."""
import argparse
import json
import os
import pwd
import sys

from common import Denied
import policy

def main():
    if os.getuid() != 0:
        raise Denied('GUEST_ADMIN_REQUIRED')
    user = pwd.getpwnam('secure-policy')
    os.setgroups([])
    os.setgid(user.pw_gid)
    os.setuid(user.pw_uid)
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest='op', required=True)
    sub.add_parser('pending')
    for op in ('show', 'deny', 'revoke'):
        sub.add_parser(op).add_argument('id')
    approve = sub.add_parser('approve')
    approve.add_argument('id')
    approve.add_argument('--digest', required=True, help='Exact digest shown with the full action')
    rule = sub.add_parser('gmail-read')
    rule.add_argument('mode', choices=('allow', 'deny'))
    args = parser.parse_args()
    if args.op == 'pending':
        value = policy.inspect()
    elif args.op == 'show':
        value = policy.inspect(args.id)
    elif args.op == 'gmail-read':
        value = policy.set_read(args.mode == 'allow')
    else:
        value = policy.decide(args.id, {'approve': 'APPROVED', 'deny': 'DENIED', 'revoke': 'REVOKED'}[args.op], getattr(args, 'digest', None))
    print(json.dumps(value, ensure_ascii=True, indent=2))

if __name__ == '__main__':
    try:
        main()
    except Denied as exc:
        print(json.dumps({'error': str(exc)}))
        sys.exit(1)
