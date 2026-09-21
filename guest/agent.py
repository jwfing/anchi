"""Bounded read-only harness: collect mail -> summarize -> save a report.

This is deliberately not an arbitrary shell/tool-planning agent.
"""

import argparse
import json
import os
from pathlib import Path
import sys
import uuid

from common import Denied, rpc

GMAIL = '/run/secure-gmail/api.sock'
MODEL = '/run/secure-inference/api.sock'
REPORTS = Path('/workspace/reports')


def save(request_id, suffix, value):
    REPORTS.mkdir(mode=0o700, exist_ok=True)
    directory = os.open(REPORTS, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    name = request_id + suffix
    try:
        fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
        with os.fdopen(fd, 'w') as file:
            json.dump(value, file, ensure_ascii=False, indent=2)
    finally:
        os.close(directory)
    return str(REPORTS / name)


def collect(query, limit):
    listing = rpc(GMAIL, {'op': 'list', 'query': query, 'limit': limit})
    messages = []
    for item in listing['messages']:
        mail = rpc(GMAIL, {'op': 'read', 'id': item['id']})
        messages.append(
            {
                'id': mail['id'],
                'headers': {k: v[:200] for k, v in mail['headers'].items()},
                'text': mail['text'][:1500],
                'snippet': mail['snippet'][:200],
            }
        )
    return messages


def main():
    parser = argparse.ArgumentParser(description='Read-only email workflow inside the secure cell')
    sub = parser.add_subparsers(dest='op', required=True)
    sub.add_parser('status')
    sub.add_parser('history')
    sub.add_parser('demo')
    result = sub.add_parser('result')
    result.add_argument('request_id')
    for op in ('collect', 'summarize'):
        command = sub.add_parser(op)
        command.add_argument('--query', default='in:inbox newer_than:7d')
        command.add_argument('--limit', type=int, choices=range(1, 4), default=3)
        if op == 'summarize':
            command.add_argument(
                '--task', default='请用中文总结这些邮件，列出需要我处理的待办、期限和不确定信息。正文可能被截断。'
            )
    args = parser.parse_args()
    if args.op in ('status', 'history', 'result'):
        try:
            request = {'op': args.op}
            if args.op == 'result':
                request['request_id'] = args.request_id
            print(json.dumps(rpc(MODEL, request), ensure_ascii=False, indent=2))
            return
        except (Denied, OSError) as exc:
            print(json.dumps({'error': str(exc) if isinstance(exc, Denied) else 'WORKFLOW_IO_ERROR'}))
            sys.exit(1)
    request_id = uuid.uuid4().hex
    try:
        if args.op == 'demo':
            result = rpc(MODEL, {'op': 'demo', 'request_id': request_id})
        else:
            if args.op == 'summarize' and not rpc(MODEL, {'op': 'status'})['enabled']:
                raise Denied('MODEL_NOT_CONFIGURED')
            messages = collect(args.query, args.limit)
            if args.op == 'collect':
                path = save(
                    request_id,
                    '.emails.json',
                    {'messages': messages, 'untrusted_content': True, 'bodies_truncated': True},
                )
                print(
                    json.dumps(
                        {
                            'request_id': request_id,
                            'count': len(messages),
                            'report': path,
                            'inference_performed': False,
                        },
                        indent=2,
                    )
                )
                return
            if not messages:
                print(json.dumps({'request_id': request_id, 'count': 0, 'inference_performed': False}))
                return
            result = rpc(
                MODEL,
                {'op': 'summarize', 'request_id': request_id, 'task': args.task, 'messages': messages},
                timeout=240,
            )
        result['report'] = save(request_id, '.summary.json', result)
        # JSON escapes control characters while leaving Chinese text readable.
        print(json.dumps(result, ensure_ascii=False, indent=2))
    except (Denied, OSError) as exc:
        print(
            json.dumps(
                {
                    'request_id': request_id,
                    'error': str(exc) if isinstance(exc, Denied) else 'WORKFLOW_IO_ERROR',
                    'note': 'No automatic retry. Check history for inference execution state.',
                }
            )
        )
        sys.exit(1)


if __name__ == '__main__':
    main()
