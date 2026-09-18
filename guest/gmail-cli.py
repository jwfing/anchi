import argparse
import json
import sys
from common import Denied, rpc

parser = argparse.ArgumentParser(description='Read-only Gmail connector; no credentials in this process.')
sub = parser.add_subparsers(dest='op', required=True)
sub.add_parser('status')
listing = sub.add_parser('list')
listing.add_argument('--query', default='in:inbox')
listing.add_argument('--limit', type=int, default=5)
reading = sub.add_parser('read')
reading.add_argument('id')
try:
    print(json.dumps(rpc('/run/secure-gmail/api.sock', vars(parser.parse_args())), ensure_ascii=True, indent=2))
except (Denied, OSError) as exc:
    print(json.dumps({'error': str(exc) if isinstance(exc, Denied) else 'CONNECTOR_UNAVAILABLE'}))
    sys.exit(1)
