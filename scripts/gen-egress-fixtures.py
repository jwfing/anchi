"""Replays the Python egress rules (the VM's source of truth) over a fixed corpus of requests and
writes what they decide as fixtures for the TypeScript rules of the host placement
(anchi/packages/host-services/test/fixtures/egress.json). Placeholders and fake tokens only.

python3 scripts/gen-egress-fixtures.py           # rewrite the file
python3 scripts/gen-egress-fixtures.py --check   # fail if it is out of date (make check)
"""

import base64
import datetime
import json
import sys
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'services'))
import egress_rules as rules  # noqa: E402

OUT = ROOT / 'anchi/packages/host-services/test/fixtures/egress.json'
FAKE_AWS = {
    'access_key_id': 'AKIAI44QH8DHBEXAMPLE',
    'secret_access_key': 'fake/secret/key/0000000000',
    'region': 'us-east-1',
}
FIXED_NOW = datetime.datetime(2026, 1, 2, 3, 4, 5, tzinfo=datetime.timezone.utc)
ALL = {'github', 'aws', 'linear', 'codex', 'claude', 'posthog', 'sentry', 'firecrawl', 'figma', 'discord'}
# Values that must never appear in a fixture: anything shaped like a real credential that is
# not a placeholder or AWS's documented example key.
REAL_SHAPES = (r'sk-ant-\S+', r'gh[pou]_\S+', r'github_pat_\S+', r'A[KS]IA[A-Z0-9]{12,}', r'lin_api_\S+')
ALLOWED_VALUES = {'AKIAI44QH8DHBEXAMPLE', 'AKIAANCHIPLACEHOLDER'}


def signed_headers(service, body=b'', target=None, host=None, path='/', region='us-east-1', extra=None):
    """Headers of a request the AWS CLI in a session would send (placeholder key), at a fixed time."""
    from botocore.auth import SigV4Auth
    from botocore.awsrequest import AWSRequest
    from botocore.credentials import Credentials

    host = host or f'{service}.{region}.amazonaws.com'
    headers = {'content-type': 'application/x-amz-json-1.1' if target else 'application/x-www-form-urlencoded'}
    if target:
        headers['x-amz-target'] = target
    headers.update(extra or {})
    request = AWSRequest(method='POST', url=f'https://{host}{path}', data=body, headers=headers)
    with fixed_time():
        SigV4Auth(Credentials(rules.PLACEHOLDER_AWS_KEY, 'anchi-placeholder-secret'), service, region).add_auth(request)
    return host, {k.lower(): v for k, v in request.headers.items()}


class fixed_time:
    """botocore reads the clock through botocore.auth.get_current_datetime in add_auth."""

    def __enter__(self):
        self.patcher = patch('botocore.auth.get_current_datetime', return_value=FIXED_NOW)
        self.patcher.start()
        return self

    def __exit__(self, *exc):
        self.patcher.stop()


def decision_cases():
    cases = []
    plain = [
        ('GET', 'example.com', '/', {}, b''),
        ('GET', 'chatgpt.com', '/backend-api/codex/models', {}, b''),
        ('POST', 'chatgpt.com', '/backend-api/codex/responses', {'authorization': 'Bearer anchi-placeholder'}, b''),
        ('POST', 'chatgpt.com', '/backend-api/ps/mcp', {'authorization': 'Bearer anchi-placeholder'}, b''),
        ('POST', 'auth.openai.com', '/oauth/token', {}, b''),
        (
            'POST',
            'api.anthropic.com',
            '/v1/messages',
            {'authorization': f'Bearer {rules.PLACEHOLDER_CLAUDE_OAUTH}'},
            b'',
        ),
        ('POST', 'api.anthropic.com', '/v1/messages', {'x-api-key': rules.PLACEHOLDER_CLAUDE_KEY}, b''),
        ('POST', 'api.anthropic.com', '/v1/organizations/api_keys', {'x-api-key': rules.PLACEHOLDER_CLAUDE_KEY}, b''),
        ('POST', 'claude.ai', '/v1/OAuth/Token', {}, b''),
        ('GET', 'api.github.com', '/user', {}, b''),
        ('GET', 'api.github.com', '/repos/o/r/issues?state=open', {'authorization': 'token anchi-placeholder'}, b''),
        ('POST', 'api.github.com', '/user/keys', {}, b''),
        ('PUT', 'api.github.com', '/repos/o/r/actions/secrets/X', {}, b''),
        ('PUT', 'api.github.com', '/repos/o/r/pulls/7/merge', {}, b''),
        ('DELETE', 'api.github.com', '/repos/o/r', {}, b''),
        ('PATCH', 'api.github.com', '/repos/o/r', {}, b''),
        ('DELETE', 'api.github.com', '/repos/o/r/git/refs/heads/x', {}, b''),
        ('POST', 'api.github.com', '/repos/o/r/hooks', {}, b''),
        ('POST', 'api.github.com', '/graphql', {}, b'{"query":"query { viewer { login } }"}'),
        ('POST', 'api.github.com', '/graphql', {}, b'{"query":"mutation { mergePullRequest(input: {}) { x } }"}'),
        (
            'POST',
            'api.github.com',
            '/graphql',
            {},
            b'{"query":"# c\\nquery Q { v } mutation M { deleteRef(input: {}) { x } }"}',
        ),
        ('POST', 'api.github.com', '/graphql', {}, b'not json'),
        ('POST', 'api.github.com', '/graphql', {}, b'{"query":"query { search(query: \\"mutation { x }\\") { x } }"}'),
        ('GET', 'github.com', '/o/r.git/info/refs?service=git-upload-pack', {}, b''),
        ('POST', 'github.com', '/o/r.git/git-upload-pack', {}, b''),
        ('GET', 'github.com', '/o/r/releases/download/v1/x.tgz', {}, b''),
        ('GET', 'github.com', '/login', {}, b''),
        ('POST', 'api.linear.app', '/graphql', {}, b'{"query":"query { issue(id: \\"X-1\\") { title } }"}'),
        (
            'POST',
            'api.linear.app',
            '/graphql',
            {},
            b'{"query":"mutation { apiKeyCreate(input: {label: \\"x\\"}) { apiKey { id } } }"}',
        ),
        ('POST', 'api.linear.app', '/graphql', {}, b'{"query":"mutation { issueDelete(id: 1) { success } }"}'),
        ('POST', 'api.linear.app', '/graphql', {}, b'{"query":"mutation { commentCreate(input: {}) { success } }"}'),
        ('GET', 'us.posthog.com', '/api/projects/1/insights/', {}, b''),
        ('POST', 'us.posthog.com', '/api/projects/1/query/', {}, b''),
        ('POST', 'us.posthog.com', '/api/personal_api_keys/', {}, b''),
        ('DELETE', 'eu.posthog.com', '/api/organizations/o1', {}, b''),
        ('POST', 'us.posthog.com', '/api/organizations/o1/invites/', {}, b''),
        ('GET', 'us.posthog.com', '/project/1/insights', {}, b''),
        ('GET', 'sentry.io', '/api/0/organizations/', {}, b''),
        ('POST', 'sentry.io', '/api/0/api-tokens/', {}, b''),
        ('DELETE', 'sentry.io', '/api/0/projects/o/p/', {}, b''),
        ('POST', 'sentry.io', '/api/123/envelope/', {}, b''),
        ('POST', 'api.firecrawl.dev', '/v2/scrape', {}, b''),
        ('GET', 'api.figma.com', '/v1/files/abc', {}, b''),
        ('POST', 'api.figma.com', '/v2/webhooks', {}, b''),
        ('POST', 'discord.com', '/api/v10/channels/1/messages', {}, b''),
        ('GET', 'discord.com', '/api/v10/channels/1/webhooks', {}, b''),
        ('DELETE', 'discord.com', '/api/v10/guilds/1', {}, b''),
        ('PUT', 'discord.com', '/api/v10/guilds/1/bans/2', {}, b''),
        ('GET', 'discord.com', '/channels/1/2', {}, b''),
        ('GET', 'awscli.amazonaws.com', '/awscli.zip', {}, b''),
    ]
    aws = [
        ('logs', b'{"logGroupName":"/app"}', 'Logs_20140328.FilterLogEvents', None, '/'),
        ('logs', b'{}', 'Logs_20140328.DeleteLogGroup', None, '/'),
        ('sts', b'Action=GetCallerIdentity&Version=2011-06-15', None, None, '/'),
        ('sts', b'Action=AssumeRole&Version=2011-06-15', None, None, '/'),
        ('iam', b'Action=ListUsers&Version=2010-05-08', None, None, '/'),
        ('iam', b'Action=CreateAccessKey&Version=2010-05-08', None, None, '/'),
        ('sso', b'{}', 'SWBPortalService.GetRoleCredentials', None, '/'),
        ('s3', b'', None, 's3.us-east-1.amazonaws.com', '/bucket?delete'),
        ('s3', b'', None, 's3.us-east-1.amazonaws.com', '/bucket?policy'),
        ('s3', b'', None, 's3.us-east-1.amazonaws.com', '/bucket/key?partNumber=1&uploadId=x'),
        ('s3', b'', None, 'bucket.s3.amazonaws.com', '/key'),
        ('ec2', b'Action=TerminateInstances&Version=2016-11-15', None, None, '/'),
        ('ec2', b'Action=DescribeInstances&Version=2016-11-15', None, None, '/'),
    ]
    for method, host, path, headers, body in plain:
        for grants in (ALL, {'codex'}):
            cases.append(describe(method, host, path, headers, body, grants))
    for service, body, target, host, path in aws:
        host, headers = signed_headers(service, body, target, host, path)
        method = (
            'POST'
            if '?' not in path and host.startswith(service)
            else ('DELETE' if path.endswith('?delete') else 'PUT')
        )
        cases.append(describe(method, host, path, headers, body, ALL))
    return cases


def describe(method, host, path, headers, body, grants):
    decision = rules.decide(method, host, path, headers, body, grants)
    out = {
        'method': method,
        'host': host,
        'path': path,
        'headers': headers,
        'body': base64.b64encode(body).decode(),
        'grants': sorted(grants),
        'action': decision.action,
        'rule': decision.rule.name if decision.rule else None,
        'op': decision.op,
        'reason': decision.reason,
    }
    if decision.action == 'inject':
        out['write'] = rules.is_write(decision, method, path, body)
        risk = rules.high_risk(decision, method, path, body)
        out['risk'] = risk[0] if risk else None
    if decision.action == 'deny':
        status, content, extra = rules.deny_response(decision, headers)
        out['deny'] = {'status': status, 'body': content.decode(), 'content_type': extra['content-type']}
    return out


def aws_cases():
    """botocore's signature of requests re-signed with the fake key, at the fixed time."""
    cases = []
    requests = [
        (
            'POST',
            'https://logs.us-east-1.amazonaws.com/',
            {'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'Logs_20140328.FilterLogEvents'},
            b'{"logGroupName":"/app"}',
            'logs',
            None,
        ),
        (
            'POST',
            'https://sts.us-east-1.amazonaws.com/',
            {'content-type': 'application/x-www-form-urlencoded'},
            b'Action=GetCallerIdentity&Version=2011-06-15',
            'sts',
            'fake-session',
        ),
        (
            'GET',
            'https://s3.us-east-1.amazonaws.com/bucket?list-type=2&prefix=a%2Fb&max-keys=10',
            {'x-amz-content-sha256': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'},
            b'',
            's3',
            None,
        ),
        (
            'PUT',
            'https://bucket.s3.amazonaws.com/some%20key/with%2Fslash.txt',
            {'x-amz-content-sha256': 'UNSIGNED-PAYLOAD', 'content-type': 'text/plain'},
            b'hello',
            's3',
            None,
        ),
        (
            'PUT',
            'https://bucket.s3.amazonaws.com/key',
            {
                'x-amz-content-sha256': 'STREAMING-AWS4-HMAC-SHA256-PAYLOAD',
                'content-encoding': 'aws-chunked',
                'x-amz-decoded-content-length': '66560',
            },
            b'',
            's3',
            None,
        ),
        (
            'POST',
            'https://ec2.eu-west-1.amazonaws.com/',
            {
                'content-type': 'application/x-www-form-urlencoded',
                'user-agent': 'aws-cli/2',
                'expect': '100-continue',
                'x-amz-date': 'ignored',
                'authorization': 'ignored',
                'connection': 'keep-alive',
            },
            b'Action=DescribeInstances&Version=2016-11-15',
            'ec2',
            None,
        ),
        (
            'GET',
            'https://dynamodb.us-east-1.amazonaws.com/a/../b/./c//d',
            {'x-amz-target': 'DynamoDB_20120810.ListTables', 'content-type': 'application/x-amz-json-1.0'},
            b'{}',
            'dynamodb',
            None,
        ),
        ('GET', 'https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08&b=2&a=1&a=0', {}, b'', 'iam', None),
    ]
    for method, url, headers, body, service, session in requests:
        credential = {**FAKE_AWS, 'session_token': session} if session else FAKE_AWS
        region = url.split('.')[1] if url.count('.') >= 3 and url.split('.')[1] != 'amazonaws' else 'us-east-1'
        if 'ec2.eu-west-1' in url:
            region = 'eu-west-1'
        with fixed_time():
            signed = rules.aws_resign(method, url, headers, body, region, service, credential)
        cases.append(
            {
                'method': method,
                'url': url,
                'headers': headers,
                'body': base64.b64encode(body).decode(),
                'region': region,
                'service': service,
                'credential': credential,
                'signed': signed,
            }
        )
    return cases


def main():
    fixtures = {
        'note': 'Generated by scripts/gen-egress-fixtures.py from services/egress_rules.py; do not edit.',
        'now': FIXED_NOW.strftime('%Y%m%dT%H%M%SZ'),
        'decisions': decision_cases(),
        'aws': aws_cases(),
    }
    text = json.dumps(fixtures, indent=1, sort_keys=True) + '\n'
    import re

    for shape in REAL_SHAPES:
        for found in re.findall(shape, text):
            value = found.rstrip('",')
            if 'anchi' not in value and 'fake' not in value and value not in ALLOWED_VALUES:
                sys.exit(f'fixture would carry a value shaped like a real credential ({value[:12]!r}…)')
    if '--check' in sys.argv:
        if not OUT.exists() or OUT.read_text() != text:
            sys.exit(f'{OUT.relative_to(ROOT)} is out of date: run python3 scripts/gen-egress-fixtures.py')
        print(f'{OUT.relative_to(ROOT)} is current.')
        return
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(text)
    print(
        f'wrote {OUT.relative_to(ROOT)}: {len(fixtures["decisions"])} decisions, {len(fixtures["aws"])} AWS signatures'
    )


if __name__ == '__main__':
    main()
