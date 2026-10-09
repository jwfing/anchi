"""Agent-team egress proxy decisions, credential cache and cell registry; fake credentials only."""

import asyncio
import base64
import json
import os
from pathlib import Path
import socket
import sys
import shutil
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'services'))
import egress_rules as rules

GITHUB = {'token': 'ghp_fakefakefakefakefakefake', 'generation': 'g'}
CODEX = {'token': 'fake-codex-access', 'account_id': 'acct-123'}
LINEAR = {'token': 'lin_api_fakefakefakefakefake', 'generation': 'g'}
AWS = {
    'access_key_id': 'AKIAI44QH8DHBEXAMPLE',
    'secret_access_key': 'fake/secret/key/0000000000',
    'region': 'us-east-1',
}
CLAUDE_OAUTH = {'token': 'sk-ant-oat01-fakefakefakefakefakefakefakefake', 'kind': 'oauth'}
CLAUDE_KEY = {'token': 'sk-ant-api03-fakefakefakefakefakefakefakefake', 'kind': 'api_key'}
ALL = {'github', 'aws', 'linear', 'codex', 'claude'}


def decide(method, host, path, headers=None, body=b'', grants=ALL):
    return rules.decide(method, host, path, {k.lower(): v for k, v in (headers or {}).items()}, body, grants)


def signed(service, region='us-east-1', target=None, body=b'', path='/', host=None):
    """A request signed with the placeholder key, as the AWS CLI in a cell would send it."""
    from botocore.auth import SigV4Auth
    from botocore.awsrequest import AWSRequest
    from botocore.credentials import Credentials

    host = host or f'{service}.{region}.amazonaws.com'
    headers = {'content-type': 'application/x-amz-json-1.1' if target else 'application/x-www-form-urlencoded'}
    if target:
        headers['x-amz-target'] = target
    request = AWSRequest(method='POST', url=f'https://{host}{path}', data=body, headers=headers)
    SigV4Auth(Credentials(rules.PLACEHOLDER_AWS_KEY, 'anchi-placeholder-secret'), service, region).add_auth(request)
    return host, {k.lower(): v for k, v in request.headers.items()}


def example_resigner(seed, trailer):
    """A ChunkResigner keyed like the S3 reference's streaming examples (the documented example secret)."""
    import hashlib
    import hmac

    key = b'AWS4wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
    for part in ('20130524', 'us-east-1', 's3', 'aws4_request'):
        key = hmac.new(key, part.encode(), hashlib.sha256).digest()
    return rules.ChunkResigner(key, '20130524T000000Z', '20130524/us-east-1/s3/aws4_request', seed, trailer)


def pkt(line):
    return b'%04x' % (len(line) + 4) + line


def git_push(*updates, caps=b'report-status side-band-64k', pack=b'PACK\x00\x00\x00\x02'):
    """A git-receive-pack body: ref updates (old, new, ref), a flush, then the pack."""
    lines = [b'%s %s %s' % u for u in updates]
    lines[0] += b'\x00' + caps
    return b''.join(pkt(line + b'\n') for line in lines) + b'0000' + pack


class DecisionTests(unittest.TestCase):
    def test_unmatched_hosts_pass_through(self):
        self.assertEqual(decide('GET', 'example.com', '/').action, 'pass')
        self.assertEqual(decide('GET', 'deb.debian.org', '/debian/dists').action, 'pass')

    def test_codex_is_replace_only(self):
        placeholder = {'authorization': f'Bearer {rules.PLACEHOLDER_MARK}', 'chatgpt-account-id': 'acct-123'}
        decision = decide('POST', 'chatgpt.com', '/backend-api/codex/responses', placeholder)
        self.assertEqual(decision.action, 'inject')
        headers = rules.apply(decision, 'POST', 'https://chatgpt.com/x', placeholder, b'', CODEX)
        self.assertEqual(headers['authorization'], 'Bearer fake-codex-access')
        self.assertEqual(headers['chatgpt-account-id'], 'acct-123')
        # Unauthenticated requests to the same host never receive the credential.
        self.assertEqual(decide('GET', 'chatgpt.com', '/backend-api/plugins').reason, 'no-placeholder')
        other = decide('GET', 'chatgpt.com', '/x', {'authorization': 'Bearer someone-else'})
        self.assertEqual((other.action, other.reason), ('pass', 'no-placeholder'))

    def test_claude_is_replace_only_for_either_credential_kind(self):
        oauth = {'authorization': f'Bearer {rules.PLACEHOLDER_CLAUDE_OAUTH}', 'anthropic-beta': 'oauth-2025-04-20'}
        decision = decide('POST', 'api.anthropic.com', '/v1/messages', oauth)
        self.assertEqual(decision.action, 'inject')
        headers = rules.apply(decision, 'POST', 'https://api.anthropic.com/v1/messages', oauth, b'', CLAUDE_OAUTH)
        self.assertEqual(headers['authorization'], f'Bearer {CLAUDE_OAUTH["token"]}')
        self.assertEqual(headers['anthropic-beta'], 'oauth-2025-04-20')
        key = {'x-api-key': rules.PLACEHOLDER_CLAUDE_KEY}
        decision = decide('POST', 'api.anthropic.com', '/v1/messages', key)
        headers = rules.apply(decision, 'POST', 'https://api.anthropic.com/v1/messages', key, b'', CLAUDE_KEY)
        self.assertEqual(headers['x-api-key'], CLAUDE_KEY['token'])
        self.assertNotIn('authorization', headers)
        # No placeholder, no credential; a Codex agent gets nothing here either.
        self.assertEqual(decide('GET', 'api.anthropic.com', '/mcp-registry/v0/servers').reason, 'no-placeholder')
        codex_only = decide('POST', 'api.anthropic.com', '/v1/messages', oauth, grants={'codex'})
        self.assertEqual((codex_only.action, codex_only.reason), ('pass', 'not-granted'))
        self.assertEqual(decide('POST', 'api.anthropic.com', '/v1/organizations/api_keys', oauth).action, 'deny')
        self.assertEqual(decide('POST', 'console.anthropic.com', '/v1/oauth/token').action, 'deny')
        self.assertEqual(decide('POST', 'claude.ai', '/v1/oauth/token').action, 'deny')

    def test_token_refresh_is_denied_for_everyone(self):
        for grants in (ALL, set()):
            self.assertEqual(decide('POST', 'auth.openai.com', '/oauth/token', grants=grants).action, 'deny')

    def test_github_api_bearer_and_deny_list(self):
        decision = decide('GET', 'api.github.com', '/repos/o/r/issues', {'authorization': 'token anchi-placeholder'})
        self.assertEqual(decision.action, 'inject')
        headers = rules.apply(decision, 'GET', 'https://api.github.com/x', {'authorization': 'x'}, b'', GITHUB)
        self.assertEqual(headers['authorization'], f'Bearer {GITHUB["token"]}')
        # Connectors inject unconditionally, even without a placeholder (gh may send none).
        self.assertEqual(decide('GET', 'api.github.com', '/user').action, 'inject')
        self.assertEqual(decide('POST', 'api.github.com', '/graphql').action, 'inject')
        for method, path in (
            ('POST', '/user/keys'),
            ('POST', '/repos/o/r/keys'),
            ('POST', '/app/installations/1/access_tokens'),
            ('PUT', '/repos/o/r/actions/secrets/X'),
            ('GET', '/orgs/o/actions/secrets'),
            ('PUT', '/repos/o/r/environments/prod/secrets/X'),
        ):
            self.assertEqual(decide(method, 'api.github.com', path).action, 'deny', path)

    def test_git_basic_only_on_smart_http(self):
        for path in ('/o/r.git/info/refs?service=git-upload-pack', '/o/r/git-receive-pack', '/o/r.git/git-upload-pack'):
            decision = decide('GET', 'github.com', path)
            self.assertEqual(decision.action, 'inject', path)
        headers = rules.apply(decision, 'POST', 'https://github.com/o/r.git/git-upload-pack', {}, b'', GITHUB)
        user, _, token = base64.b64decode(headers['authorization'][6:]).decode().partition(':')
        self.assertEqual((user, token), ('x-access-token', GITHUB['token']))
        for path in ('/o/r/releases/download/v1/x.tgz', '/login', '/o/r'):
            self.assertEqual(decide('GET', 'github.com', path).action, 'pass', path)

    def test_agent_without_connector_gets_no_injection(self):
        for host, path in (
            ('api.github.com', '/user'),
            ('github.com', '/o/r/info/refs'),
            ('api.linear.app', '/graphql'),
        ):
            decision = decide('GET', host, path, {'authorization': 'Bearer anchi-placeholder'}, grants={'codex'})
            self.assertEqual((decision.action, decision.reason), ('pass', 'not-granted'), host)

    def test_linear_raw_key_and_key_minting_denied(self):
        body = json.dumps({'query': 'query { issue(id: "X-1") { title } }'}).encode()
        decision = decide('POST', 'api.linear.app', '/graphql', body=body)
        self.assertEqual((decision.action, decision.op), ('inject', 'graphql:query,issue'))
        headers = rules.apply(decision, 'POST', 'https://api.linear.app/graphql', {}, body, LINEAR)
        self.assertEqual(headers['authorization'], LINEAR['token'])
        mint = json.dumps({'query': 'mutation { apiKeyCreate(input: {label: "x"}) { apiKey { id } } }'}).encode()
        self.assertEqual(decide('POST', 'api.linear.app', '/graphql', body=mint).action, 'deny')

    def test_aws_resigns_signed_requests_only(self):
        body = b'{"logGroupName":"/app"}'
        host, headers = signed('logs', target='Logs_20140328.FilterLogEvents', body=body)
        decision = decide('POST', host, '/', headers, body)
        self.assertEqual((decision.action, decision.op), ('inject', 'logs:FilterLogEvents'))
        new = rules.apply(decision, 'POST', f'https://{host}/', headers, body, AWS)
        self.assertIn(f'Credential={AWS["access_key_id"]}/', new['authorization'])
        self.assertNotIn(rules.PLACEHOLDER_AWS_KEY, json.dumps(new))
        self.assertNotIn('x-amz-security-token', new)
        # Unsigned downloads (installers, public objects) are not touched.
        self.assertEqual(decide('GET', 'awscli.amazonaws.com', '/awscli.zip').reason, 'unsigned')

    def test_aws_session_token_is_signed_in(self):
        body = b'Action=GetCallerIdentity&Version=2011-06-15'
        host, headers = signed('sts', body=body)
        decision = decide('POST', host, '/', headers, body)
        new = rules.apply(decision, 'POST', f'https://{host}/', headers, body, {**AWS, 'session_token': 'fake-session'})
        self.assertEqual(new['x-amz-security-token'], 'fake-session')

    def test_aws_minting_denied_in_service_error_shape(self):
        cases = (
            ('sts', b'Action=GetSessionToken&Version=2011-06-15', None),
            ('sts', b'Action=AssumeRole&Version=2011-06-15', None),
            ('iam', b'Action=CreateAccessKey&Version=2010-05-08', None),
        )
        for service, body, target in cases:
            host, headers = signed(service, body=body, target=target)
            decision = decide('POST', host, '/', headers, body)
            self.assertEqual(decision.action, 'deny', body)
            status, content, extra = rules.deny_response(decision, headers)
            self.assertEqual((status, extra['content-type']), (403, 'text/xml'))
            self.assertIn(b'<Code>AccessDenied</Code>', content)
        host, headers = signed('sso', target='SWBPortalService.GetRoleCredentials')
        decision = decide('POST', host, '/', headers)
        status, content, extra = rules.deny_response(decision, headers)
        self.assertEqual(json.loads(content)['__type'], 'AccessDeniedException')
        host, headers = signed('iam', body=b'Action=ListUsers&Version=2010-05-08')
        self.assertEqual(decide('POST', host, '/', headers, b'Action=ListUsers&Version=2010-05-08').action, 'inject')

    def test_aws_chunk_signatures_match_the_aws_example(self):
        # The worked example of "Signature Calculations for the Authorization Header: Transferring
        # Payload in Multiple Chunks" in the S3 API reference: its seed and chunk signatures.
        seed = '4f232c4386841ef735655705268965c44a0e4690baa4adea153f7db9fa80a0a9'
        expected = (
            'ad80c730a21e5b8d04586a2213dd63b9a0e99e0e2307b0ade35a65485a288648',
            '0055627c9e194cb4542bae2aa5492e3c1575bbb81b612b7d234b86a503ef5497',
            'b6c6ea8a5354eaf15b3cb7646744f4275b71ea724fed81ceb9323e279d449df9',
        )
        placeholder = '0' * 64
        body = b''.join(
            f'{len(c):x};chunk-signature={placeholder}\r\n'.encode() + c + b'\r\n'
            for c in (b'a' * 65536, b'a' * 1024, b'')
        )
        for step in (len(body), 1, 7, 4096):
            resigner = example_resigner(seed, trailer=False)
            out = b''.join(resigner.feed(body[i : i + step]) for i in range(0, len(body), step))
            out += resigner.feed(b'')
            self.assertEqual(len(out), len(body))
            self.assertEqual(
                [line.split(b'=')[1].decode() for line in out.split(b'\r\n') if b'chunk-signature' in line],
                list(expected),
            )
            self.assertEqual(out.replace(b'a', b'').count(b'\r\n'), 6)

    def test_aws_chunked_trailer_is_re_signed(self):
        seed = '106e2a8a18243abcf37539882f36619c00e2dfc72633413f02d3b74544bfeb8e'
        placeholder = '0' * 64
        body = (
            f'10000;chunk-signature={placeholder}\r\n'.encode()
            + b'a' * 65536
            + f'\r\n400;chunk-signature={placeholder}\r\n'.encode()
            + b'a' * 1024
            + f'\r\n0;chunk-signature={placeholder}\r\n'.encode()
            + f'x-amz-checksum-crc32c:sOO8/Q==\r\nx-amz-trailer-signature:{placeholder}\r\n\r\n'.encode()
        )
        resigner = example_resigner(seed, trailer=True)
        out = resigner.feed(body[:70000]) + resigner.feed(body[70000:]) + resigner.feed(b'')
        self.assertEqual(len(out), len(body))
        signatures = [line.split(b'=', 1)[1] for line in out.split(b'\r\n') if b'chunk-signature' in line]
        # Chunk signatures of the trailer example in the same reference.
        self.assertEqual(
            [s.decode() for s in signatures],
            [
                'b474d8862b1487a5145d686f57f013e54db672cee1c953b3010fb58501ef5aa2',
                '1c1344b170168f8e65b41376b44b20fe354e373826ccbbe2c1d40a8cae51e5c7',
                '2ca2aba2005185cf7159c6277faf83795951dd77a3a99e6e65d5c9f85863f992',
            ],
        )
        trailer = out.split(b'x-amz-trailer-signature:')[1]
        self.assertRegex(trailer, rb'^[0-9a-f]{64}\r\n\r\n$')
        self.assertNotIn(placeholder.encode(), out)

    def test_malformed_aws_chunked_bodies_are_refused(self):
        sig = '0' * 64
        cases = (
            b'zz;chunk-signature=' + sig.encode() + b'\r\n',
            b'1000001;chunk-signature=' + sig.encode() + b'\r\n',
            b'1;chunk-signature=' + sig.encode() + b'\r\naXX',
            b'x' * 200,
        )
        for body in cases:
            with self.assertRaises(ValueError, msg=body[:30]):
                example_resigner(sig, trailer=False).feed(body)
        resigner = example_resigner(sig, trailer=False)
        resigner.feed(b'1;chunk-signature=' + sig.encode() + b'\r\na\r\n')
        with self.assertRaises(ValueError):
            resigner.feed(b'')
        with self.assertRaises(ValueError):
            example_resigner(sig, trailer=False).feed(b'')
        resigner = example_resigner(sig, trailer=False)
        resigner.feed(b'0;chunk-signature=' + sig.encode() + b'\r\n\r\n')
        with self.assertRaises(ValueError):
            resigner.feed(b'more')

    def test_aws_streaming_payloads_are_re_signed(self):
        host, headers = signed('s3', host='bucket.s3.amazonaws.com')
        for payload, chunked in (
            ('STREAMING-UNSIGNED-PAYLOAD-TRAILER', False),
            ('STREAMING-AWS4-HMAC-SHA256-PAYLOAD', True),
            ('STREAMING-AWS4-HMAC-SHA256-PAYLOAD-TRAILER', True),
        ):
            sent = {**headers, 'x-amz-content-sha256': payload, 'content-encoding': 'aws-chunked'}
            decision = decide('PUT', host, '/key', sent)
            new = rules.apply(decision, 'PUT', f'https://{host}/key', sent, b'', AWS)
            self.assertEqual(new['x-amz-content-sha256'], payload)
            self.assertIn('x-amz-content-sha256', new['authorization'])
            self.assertIn(f'Credential={AWS["access_key_id"]}/', new['authorization'])
            resigner = rules.aws_chunk_resigner(new, AWS)
            self.assertEqual(resigner is not None, chunked)
            if resigner:
                self.assertEqual(resigner.previous, new['authorization'].rsplit('Signature=', 1)[1])
        sent = {**headers, 'x-amz-content-sha256': 'STREAMING-AWS4-ECDSA-P256-SHA256-PAYLOAD'}
        decision = decide('PUT', host, '/key', sent)
        with self.assertRaises(ValueError):
            rules.apply(decision, 'PUT', f'https://{host}/key', sent, b'', AWS)

    def test_s3_subresources_name_the_operation_and_risk(self):
        host, headers = signed('s3', host='s3.us-east-1.amazonaws.com')
        cases = (
            ('POST', '/bucket?delete', 's3:POST /bucket?delete', 'aws-s3-delete'),
            ('PUT', '/bucket?lifecycle', 's3:PUT /bucket?lifecycle', 'aws-s3-delete'),
            ('PUT', '/bucket?policy', 's3:PUT /bucket?policy', 'aws-s3-access'),
            ('PUT', '/bucket/key?acl', 's3:PUT /bucket/key?acl', 'aws-s3-access'),
            ('DELETE', '/bucket/key', 's3:DELETE /bucket/key', 'aws-s3-delete'),
            ('PUT', '/bucket/key?partNumber=1&uploadId=x', 's3:PUT /bucket/key', None),
            ('GET', '/bucket?list-type=2', 's3:GET /bucket', None),
        )
        for method, path, op, risk in cases:
            decision = decide(method, host, path, headers)
            self.assertEqual(decision.op, op)
            found = rules.high_risk(decision, method, path, b'')
            self.assertEqual(found and found[0], risk, path)

    def test_proxy_authorization_never_forwarded(self):
        decision = decide('GET', 'api.github.com', '/user')
        headers = rules.apply(decision, 'GET', 'https://api.github.com/user', {'proxy-authorization': 'x'}, b'', GITHUB)
        self.assertNotIn('proxy-authorization', headers)

    def test_verification_requests_and_accounts(self):
        method, url, headers, _ = rules.verify_request('linear', LINEAR)
        self.assertEqual(
            (method, url, headers['authorization']), ('POST', 'https://api.linear.app/graphql', LINEAR['token'])
        )
        method, url, headers, body = rules.verify_request('aws', AWS)
        self.assertEqual(url, 'https://sts.us-east-1.amazonaws.com/')
        self.assertIn(f'Credential={AWS["access_key_id"]}/', headers['authorization'])
        self.assertEqual(body, b'Action=GetCallerIdentity&Version=2011-06-15')
        self.assertEqual(rules.verify_account('github', 200, b'{"login":"octo"}'), 'octo')
        self.assertEqual(
            rules.verify_account('linear', 200, b'{"data":{"viewer":{"email":"a@b.c","name":"A"}}}'), 'a@b.c'
        )
        self.assertEqual(
            rules.verify_account('aws', 200, b'<R><Arn>arn:aws:iam::1:user/bot</Arn></R>'), 'arn:aws:iam::1:user/bot'
        )
        for connector, status, body in (
            ('github', 401, b'{"message":"Bad credentials"}'),
            ('aws', 403, b'<Error/>'),
            ('linear', 200, b'{"errors":[{"message":"Authentication required"}]}'),
        ):
            with self.assertRaisesRegex(ValueError, 'CREDENTIAL_REJECTED'):
                rules.verify_account(connector, status, body)
        with self.assertRaisesRegex(ValueError, 'VERIFY_UNEXPECTED_RESPONSE'):
            rules.verify_account('github', 200, b'<html>')

    def test_writes_are_classified_for_approval(self):
        def write(method, host, path, body=b'', headers=None):
            d = decide(method, host, path, headers or {}, body)
            return rules.is_write(d, method, path, body)

        self.assertTrue(write('POST', 'github.com', '/o/r.git/git-receive-pack'))
        self.assertFalse(write('POST', 'github.com', '/o/r.git/git-upload-pack'))
        self.assertTrue(write('POST', 'api.github.com', '/repos/o/r/pulls'))
        self.assertFalse(write('GET', 'api.github.com', '/repos/o/r/pulls'))
        self.assertFalse(write('POST', 'api.github.com', '/graphql', b'{"query": "query { viewer { login } }"}'))
        self.assertTrue(write('POST', 'api.github.com', '/graphql', b'{"query": "mutation { addComment }"}'))
        self.assertTrue(write('POST', 'api.linear.app', '/graphql', b'{"query":"mutation { commentCreate }"}'))
        self.assertFalse(write('POST', 'api.linear.app', '/graphql', b'{"query":"{ issue(id: 1) { title } }"}'))
        host, headers = signed('logs', target='Logs_20140328.FilterLogEvents')
        self.assertFalse(write('POST', host, '/', headers=headers))
        host, headers = signed('logs', target='Logs_20140328.DeleteLogGroup')
        self.assertTrue(write('POST', host, '/', headers=headers))

    def test_high_risk_operations_are_recognized_for_every_agent(self):
        def risk(method, host, path, body=b'', headers=None, disabled=()):
            d = decide(method, host, path, headers or {}, body)
            found = rules.high_risk(d, method, path, body, disabled)
            return found and found[0]

        push = lambda ref, new=b'1' * 40: git_push((b'2' * 40, new, ref))  # noqa: E731
        self.assertEqual(risk('PUT', 'api.github.com', '/repos/o/r/pulls/7/merge'), 'github-merge')
        self.assertEqual(risk('DELETE', 'api.github.com', '/repos/o/r'), 'github-repo-delete')
        self.assertEqual(
            risk('POST', 'github.com', '/o/r.git/git-receive-pack', push(b'refs/heads/main')), 'git-default-branch'
        )
        self.assertEqual(
            risk('POST', 'github.com', '/o/r.git/git-receive-pack', push(b'refs/heads/fix', b'0' * 40)),
            'git-ref-delete',
        )
        self.assertIsNone(risk('POST', 'github.com', '/o/r.git/git-receive-pack', push(b'refs/heads/fix')))
        # Every update is read, however many come first; a list too long to read, or not a list
        # of updates, is high-risk.
        many = [(b'2' * 40, b'1' * 40, b'refs/heads/f%d' % i) for i in range(500)]
        self.assertEqual(
            risk(
                'POST',
                'github.com',
                '/o/r.git/git-receive-pack',
                git_push(*many[:300], (b'2' * 40, b'1' * 40, b'refs/heads/main')),
            ),
            'git-default-branch',
        )
        for body in (
            git_push(*many, *many, *many),
            b'refs/heads/fix',
            git_push((b'2' * 40, b'1' * 40, b'refs/heads/fix'))[:60],
        ):
            self.assertEqual(risk('POST', 'github.com', '/o/r.git/git-receive-pack', body), 'github-push-unreadable')
        self.assertEqual(
            risk('POST', 'api.github.com', '/graphql', b'{"query":"mutation { mergePullRequest(input: {}) { x } }"}'),
            'github-graphql',
        )
        self.assertIsNone(risk('POST', 'api.github.com', '/graphql', b'{"query":"query { viewer { login } }"}'))
        self.assertIsNone(risk('POST', 'api.github.com', '/repos/o/r/pulls'))
        host, headers = signed('logs', target='Logs_20140328.DeleteLogGroup')
        self.assertEqual(risk('POST', host, '/', headers=headers), 'aws-destroy')
        host, headers = signed('logs', target='Logs_20140328.FilterLogEvents')
        self.assertIsNone(risk('POST', host, '/', headers=headers))
        self.assertEqual(
            risk('POST', 'api.linear.app', '/graphql', b'{"query":"mutation { issueDelete(id: 1) { success } }"}'),
            'linear-delete',
        )
        # The user can switch an entry off.
        self.assertIsNone(risk('PUT', 'api.github.com', '/repos/o/r/pulls/7/merge', disabled=('github-merge',)))

    def test_git_push_summary_names_the_refs(self):
        import egress_proxy

        d = decide('POST', 'github.com', '/o/r.git/git-receive-pack')
        body = b'00a8' + b'0' * 40 + b' ' + b'1' * 40 + b' refs/heads/fix-12\x00 report-status\n0000PACK...'
        self.assertEqual(egress_proxy.write_summary(d, 'POST', '/o/r', body), 'git push: refs/heads/fix-12')

    def test_polls_run_fixed_read_only_queries(self):
        method, url, headers, body = rules.poll_request('linear-issues', {'team': 'ENG', 'label': 'agent'}, LINEAR)
        self.assertEqual((method, url), ('POST', 'https://api.linear.app/graphql'))
        query = json.loads(body)
        self.assertTrue(query['query'].startswith('query'))
        self.assertEqual(query['variables']['filter']['labels'], {'name': {'eq': 'agent'}})
        self.assertEqual(headers['authorization'], LINEAR['token'])
        method, url, headers, _ = rules.poll_request('github-issues', {'query': 'repo:o/r is:open label:x'}, GITHUB)
        self.assertEqual(method, 'GET')
        self.assertTrue(url.startswith('https://api.github.com/search/issues?q=repo%3Ao%2Fr'))
        with self.assertRaises(ValueError):
            rules.poll_request('jira', {}, GITHUB)
        items = rules.poll_items(
            'linear-issues',
            200,
            b'{"data":{"issues":{"nodes":[{"id":"u1","identifier":"ENG-1","title":"Crash","url":"https://linear.app/x/issue/ENG-1"}]}}}',
        )
        self.assertEqual(items, [{'id': 'u1', 'title': 'ENG-1 Crash', 'url': 'https://linear.app/x/issue/ENG-1'}])
        items = rules.poll_items(
            'github-issues',
            200,
            b'{"items":[{"node_id":"I_1","title":"Bug","html_url":"https://github.com/o/r/issues/1"}]}',
        )
        self.assertEqual(items[0]['id'], 'I_1')
        with self.assertRaisesRegex(ValueError, 'CREDENTIAL_REJECTED'):
            rules.poll_items('github-issues', 401, b'{}')

    def test_credential_classification_reveals_nothing(self):
        self.assertEqual(rules.classify_credential({}), 'none')
        self.assertEqual(rules.classify_credential({'authorization': 'Bearer anchi-placeholder-x'}), 'placeholder')
        basic = 'Basic ' + base64.b64encode(b'x:anchi-placeholder').decode()
        self.assertEqual(rules.classify_credential({'authorization': basic}), 'placeholder')
        self.assertEqual(rules.classify_credential({'authorization': 'Bearer real'}), 'other')


class DestinationTests(unittest.TestCase):
    @staticmethod
    def infos(*addresses):
        return [
            (socket.AF_INET6 if ':' in a else socket.AF_INET, socket.SOCK_STREAM, 6, '', (a, 443)) for a in addresses
        ]

    def test_public_addresses_prefer_ipv4(self):
        self.assertEqual(rules.public_address(self.infos('2606:4700::1', '140.82.112.3')), ('140.82.112.3', None))

    def test_any_private_address_refuses_the_destination(self):
        for private in (
            '127.0.0.1',
            '10.0.0.1',
            '192.168.5.2',
            '169.254.169.254',
            '100.64.0.1',
            '::1',
            'fe80::1',
            '0.0.0.0',
        ):
            address, reason = rules.public_address(self.infos('140.82.112.3', private))
            self.assertIsNone(address, private)
            self.assertIn('non-public', reason)
        self.assertEqual(rules.public_address([])[0], None)


class CredentialCacheTests(unittest.TestCase):
    def test_cache_and_codex_mapping(self):
        import egress_proxy

        calls = []
        now = [0.0]

        def fetch(request):
            calls.append(request)
            if request['op'] == 'codex_token':
                return {'access_token': 'a', 'account_id': 'acct', 'expires_at': 9e12, 'generation': 'g'}
            return {'token': 't', 'generation': 'g'}

        cache = egress_proxy.Credentials(fetch, clock=lambda: now[0])
        self.assertEqual(cache.get('codex'), {'token': 'a', 'account_id': 'acct'})
        cache.get('codex')
        cache.get('github')
        self.assertEqual(len(calls), 2)
        now[0] = egress_proxy.CREDENTIAL_TTL + 1
        cache.get('github')
        self.assertEqual(calls[-1], {'op': 'egress_credential', 'connector': 'github'})
        self.assertEqual(len(calls), 3)

    def test_expired_codex_token_is_not_served(self):
        import egress_proxy

        cache = egress_proxy.Credentials(lambda r: {'access_token': 'a', 'account_id': 'x', 'expires_at': 1})
        with self.assertRaises(LookupError):
            cache.get('codex')


class RegistryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='anchi-egress-')
        import egress_proxy

        self.module = egress_proxy
        patcher = patch.multiple(egress_proxy, CELLS=Path(self.tmp) / 'cells', AUDIT=Path(self.tmp) / 'audit.jsonl')
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_register_bridges_and_maps_ports_to_cells(self):
        async def scenario():
            seen = {}

            async def upstream(reader, writer):
                port = writer.get_extra_info('peername')[1]
                seen['cell'] = registry.ports[port].task
                writer.write(await reader.readline())
                await writer.drain()
                writer.close()

            server = await asyncio.start_server(upstream, '127.0.0.1', 0)
            registry = self.module.Registry(server.sockets[0].getsockname()[:2])
            result = await registry.register({'task': 't1', 'agent': 'dev', 'connectors': ['github']})
            self.assertEqual(registry.cells['t1'].grants, frozenset({'github', 'codex'}))
            sock = Path(result['directory']) / 'proxy.sock'
            self.assertEqual(oct(sock.stat().st_mode & 0o777), '0o666')
            reader, writer = await asyncio.open_unix_connection(str(sock))
            writer.write(b'ping\n')
            await writer.drain()
            self.assertEqual(await reader.readline(), b'ping\n')
            self.assertEqual(seen['cell'], 't1')
            writer.close()
            await registry.unregister('t1')
            self.assertFalse(sock.parent.exists())
            server.close()

        asyncio.run(scenario())

    def test_register_grants_only_the_cell_runtime(self):
        async def scenario():
            registry = self.module.Registry(('127.0.0.1', 1))
            await registry.register({'task': 'tc', 'agent': 'a', 'connectors': [], 'runtime': 'claude'})
            await registry.register({'task': 'tx', 'agent': 'a', 'connectors': ['github']})
            self.assertEqual(registry.cells['tc'].grants, frozenset({'claude'}))
            self.assertEqual(registry.cells['tx'].grants, frozenset({'github', 'codex'}))
            with self.assertRaises(ValueError):
                registry.validate({'task': 'ty', 'agent': 'a', 'connectors': [], 'runtime': 'gpt'})
            for task in ('tc', 'tx'):
                await registry.unregister(task)

        asyncio.run(scenario())

    def test_claude_import_accepts_tokens_and_keys_only(self):
        import claude_admin

        self.assertEqual(claude_admin.validate({'token': CLAUDE_OAUTH['token']})['kind'], 'oauth')
        self.assertEqual(claude_admin.validate({'token': CLAUDE_KEY['token']})['kind'], 'api_key')
        for bad in (
            'sk-ant-sid01-' + 'x' * 40,
            'short',
            rules.PLACEHOLDER_CLAUDE_OAUTH,
            'sk-ant-oat01-' + 'x' * 40 + ' ',
        ):
            with self.assertRaises(Exception):
                claude_admin.validate({'token': bad})

    def test_approvals_wait_for_the_user_and_time_out(self):
        async def scenario():
            approvals = self.module.Approvals(timeout=0.2)
            seen = []

            class Watcher:
                def write(self, line):
                    seen.append(json.loads(line))

                def is_closing(self):
                    return False

            approvals.watchers.add(Watcher())
            ask = asyncio.create_task(approvals.ask({'task': 't1', 'connector': 'github', 'summary': 'git push'}))
            await asyncio.sleep(0.01)
            approval_id = seen[0]['approval']['id']
            approvals.decide(approval_id, True)
            self.assertEqual(await ask, 'approved')
            self.assertEqual(seen[-1], {'type': 'resolved', 'id': approval_id})
            denied = asyncio.create_task(approvals.ask({'task': 't1'}))
            await asyncio.sleep(0.01)
            approvals.decide(seen[-1]['approval']['id'], False)
            self.assertEqual(await denied, 'denied')
            self.assertEqual(await approvals.ask({'task': 't1'}), 'timeout')
            with self.assertRaises(ValueError):
                approvals.decide('0' * 16, True)

        asyncio.run(scenario())

    def test_settings_accept_known_high_risk_ids_only(self):
        proxy = self.module.EgressProxy(registry=self.module.Registry(('127.0.0.1', 1)))
        with patch.object(self.module, 'SETTINGS', Path(self.tmp, 'settings.json')):
            self.assertEqual(
                proxy.set_settings({'high_risk_disabled': ['github-merge']}), {'high_risk_disabled': ['github-merge']}
            )
            self.assertEqual(self.module.load_settings(), {'high_risk_disabled': ['github-merge']})
            with self.assertRaises(ValueError):
                proxy.set_settings({'high_risk_disabled': ['everything']})

    def test_egress_allowlists_add_runtime_and_connector_hosts(self):
        allow = rules.egress_allowlist(['registry.npmjs.org', '*.pypi.org'], {'codex', 'github'})
        for host in (
            'registry.npmjs.org',
            'files.pypi.org',
            'chatgpt.com',
            'sdmntprwestus.oaiusercontent.com',
            'api.github.com',
            'github.com',
        ):
            self.assertTrue(rules.egress_allowed(allow, host), host)
        for host in ('example.com', 'pypi.org.evil.com', 'api.anthropic.com', 'api.linear.app'):
            self.assertFalse(rules.egress_allowed(allow, host), host)
        self.assertTrue(rules.egress_allowed(rules.egress_allowlist(None, {'codex'}), 'example.com'))
        # The content CDN comes with Codex only.
        self.assertFalse(rules.egress_allowed(rules.egress_allowlist([], {'claude'}), 'files.oaiusercontent.com'))

        async def scenario():
            registry = self.module.Registry(('127.0.0.1', 1))
            await registry.register({'task': 'te', 'agent': 'a', 'connectors': [], 'egress': ['example.org']})
            self.assertEqual(
                registry.cells['te'].egress,
                frozenset({'example.org', 'chatgpt.com', '*.chatgpt.com', '*.oaiusercontent.com'}),
            )
            for bad in (['http://x.com'], ['*'], 'example.org', ['a' * 70 + '.com']):
                with self.assertRaises(ValueError):
                    registry.validate({'task': 'tf', 'agent': 'a', 'connectors': [], 'egress': bad})
            await registry.unregister('te')

        asyncio.run(scenario())

    def test_connector_bridge_names_the_cell_agent(self):
        async def scenario():
            seen = []

            async def service(reader, writer):
                seen.append(json.loads(await reader.readline()))
                writer.write(b'{"ok": true, "result": {"pages": []}}\n')
                await writer.drain()
                writer.close()

            sock = Path(self.tmp, 'notion.sock')
            server = await asyncio.start_unix_server(service, path=str(sock))
            # Unix socket paths are short (104 bytes on macOS); the default temporary directory is long.
            short = tempfile.mkdtemp(prefix='ae', dir='/tmp')
            self.addCleanup(shutil.rmtree, short, True)
            with (
                patch.object(self.module, 'SERVICE_SOCKET', str(Path(self.tmp, '{}.sock'))),
                patch.object(self.module, 'CELLS', Path(short)),
            ):
                registry = self.module.Registry(('127.0.0.1', 1))
                result = await registry.register(
                    {'task': 'tb', 'agent': 'dev', 'connectors': [], 'services': ['notion']}
                )
                bridge = Path(result['directory'], 'connectors', 'notion', 'api.sock')
                self.assertEqual(sorted(p.name for p in Path(result['directory'], 'connectors').iterdir()), ['notion'])
                reader, writer = await asyncio.open_unix_connection(str(bridge))
                writer.write(b'{"op": "search", "query": "x", "limit": 1, "agent": "someone-else"}\n')
                await writer.drain()
                self.assertEqual(json.loads(await reader.readline()), {'ok': True, 'result': {'pages': []}})
                writer.close()
                self.assertEqual(seen, [{'op': 'search', 'query': 'x', 'limit': 1, 'agent': 'dev'}])
                reader, writer = await asyncio.open_unix_connection(str(bridge))
                writer.write(b'[1, 2]\n')
                await writer.drain()
                self.assertEqual(json.loads(await reader.readline())['error'], 'BAD_REQUEST')
                writer.close()
                with self.assertRaises(ValueError):
                    registry.validate({'task': 'tc', 'agent': 'dev', 'connectors': [], 'services': ['github']})
                await registry.unregister('tb')
                self.assertFalse(bridge.exists())
            server.close()

        asyncio.run(scenario())

    def test_register_validates_names_and_connectors(self):
        registry = self.module.Registry(('127.0.0.1', 1))
        for request in (
            {'task': '../x', 'agent': 'a', 'connectors': []},
            {'task': 't', 'agent': 'A', 'connectors': []},
            {'task': 't', 'agent': 'a', 'connectors': ['gmail']},
            {'task': 't', 'agent': 'a', 'connectors': 'github'},
            {'task': 't', 'agent': 'a', 'connectors': ['github'], 'ask': ['aws']},
        ):
            with self.assertRaises(ValueError):
                registry.validate(request)

    def test_connects_to_the_checked_address_and_keeps_the_host_for_reuse(self):
        from types import SimpleNamespace as NS

        proxy = self.module.EgressProxy(registry=self.module.Registry(('127.0.0.1', 1)))
        server = NS(id='s1', address=('deb.debian.org', 80), sni=None, error=None)
        data = NS(client=NS(id='c1'), server=server)

        async def resolve(host, port, type):
            return [(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('151.101.2.132', port))]

        async def scenario():
            with patch.object(asyncio.get_running_loop(), 'getaddrinfo', resolve):
                await proxy.server_connect(data)

        asyncio.run(scenario())
        # mitmproxy opens the socket to this address...
        self.assertEqual(server.address, ('151.101.2.132', 80))
        proxy.server_connected(data)
        # ...and matches later requests for the same host against this one.
        self.assertEqual(server.address, ('deb.debian.org', 80))
        self.assertEqual(proxy.requested, {})

    def test_refused_hosts_are_noted_in_the_task_once(self):
        from types import SimpleNamespace as NS

        proxy = self.module.EgressProxy(registry=self.module.Registry(('127.0.0.1', 1)))
        cell = self.module.Cell('t1', 'dev', frozenset({'codex'}), egress=['example.com'])
        proxy.registry.client_cell = lambda client: cell
        notes = []
        proxy.approvals.watchers.add(type('W', (), {'write': lambda self, b: notes.append(json.loads(b))})())
        for host in ('Evil.Example.', 'evil.example', 'other.example'):
            server = NS(id='s1', address=(host, 443), sni=None, error=None)
            asyncio.run(proxy.server_connect(NS(client=NS(id='c1'), server=server)))
            self.assertIn('egress list', server.error)
        self.assertEqual(
            [n['text'] for n in notes],
            [
                f'⛔ {h} is not in the egress list; the connection was refused. To allow it, press a on the '
                f'task, then e (or anchi agents allow-host dev {h})'
                for h in ('evil.example', 'other.example')
            ],
        )

    def test_requests_to_refused_hosts_are_answered_by_the_proxy(self):
        proxy = self.proxy_with_cell()
        cell = self.module.Cell('t1', 'dev', frozenset({'github'}), egress=['example.com'])
        proxy.registry.client_cell = lambda client: cell
        responses = []
        with patch.object(self.module.EgressProxy, 'respond', staticmethod(lambda f, *a: responses.append(a[:2]))):
            for host in ('example.org', 'example.com', 'api.github.com'):
                flow, _ = self.proxy_flow('GET', host, '/', {}, False)
                asyncio.run(proxy.request(flow))
        self.assertEqual(responses, [(403, b"anchi: example.org is not in this agent's egress list\n")])
        rows = [json.loads(line) for line in Path(self.tmp, 'audit.jsonl').read_text().splitlines()]
        self.assertEqual([(r['host'], r['decision']) for r in rows][0], ('example.org', 'egress-denied'))

    def test_upstream_errors_are_audited_once(self):
        from types import SimpleNamespace as NS

        proxy = self.module.EgressProxy(registry=self.module.Registry(('127.0.0.1', 1)))
        cell = self.module.Cell('t1', 'dev', frozenset({'codex'}))
        proxy.registry.client_cell = lambda client: cell
        for error in ('connection refused', 'anchi: private address'):
            proxy.server_connect_error(
                NS(client=None, server=NS(id='s', error=error, sni='deb.debian.org', address=None))
            )
        rows = [json.loads(line) for line in Path(self.tmp, 'audit.jsonl').read_text().splitlines()]
        self.assertEqual(
            [(r['decision'], r['host'], r['reason'], r['task']) for r in rows],
            [('upstream-error', 'deb.debian.org', 'connection refused', 't1')],
        )

    def test_verify_reads_the_credential_afresh_and_calls_only_the_identity_endpoint(self):
        calls, fetched = [], []

        def fetch(request):
            fetched.append(request)
            return GITHUB

        def call(method, url, headers, body):
            calls.append((method, url, headers['authorization']))
            return 200, b'{"login": "octo"}'

        proxy = self.module.EgressProxy(
            registry=self.module.Registry(('127.0.0.1', 1)), credentials=self.module.Credentials(fetch), call=call
        )
        self.assertEqual(asyncio.run(proxy.verify('github')), {'connector': 'github', 'account': 'octo'})
        asyncio.run(proxy.verify('github'))
        self.assertEqual(len(fetched), 2)
        self.assertEqual(calls[0], ('GET', 'https://api.github.com/user', f'Bearer {GITHUB["token"]}'))
        with self.assertRaises(ValueError):
            asyncio.run(proxy.verify('gmail'))
        self.assertNotIn(GITHUB['token'], Path(self.tmp, 'audit.jsonl').read_text())

    def proxy_flow(self, method, host, path, headers, stream, content=b''):
        from types import SimpleNamespace as NS

        killed = []
        request = NS(
            method=method,
            path=path,
            url=f'https://{host}{path}',
            pretty_host=host,
            headers=dict(headers),
            stream=stream,
            raw_content=content,
            get_content=lambda strict=False: content,
        )
        flow = NS(request=request, client_conn=NS(id='c1'), metadata={}, response=None, kill=lambda: killed.append(1))
        return flow, killed

    def proxy_with_cell(self, grants=frozenset({'aws', 'github'})):
        proxy = self.module.EgressProxy(
            registry=self.module.Registry(('127.0.0.1', 1)),
            credentials=self.module.Credentials(lambda r: {'aws': AWS, 'github': GITHUB}[r['connector']]),
        )
        cell = self.module.Cell('t1', 'dev', grants)
        proxy.registry.client_cell = lambda client: cell
        return proxy

    def test_streamed_s3_uploads_are_re_signed_before_their_headers_leave(self):
        proxy = self.proxy_with_cell()
        host, headers = signed('s3', host='bucket.s3.amazonaws.com')
        headers.update(
            {'x-amz-content-sha256': 'STREAMING-AWS4-HMAC-SHA256-PAYLOAD', 'content-encoding': 'aws-chunked'}
        )
        flow, killed = self.proxy_flow('PUT', host, '/key', headers, stream=True)
        asyncio.run(proxy.requestheaders(flow))
        self.assertEqual(killed, [])
        self.assertIn(f'Credential={AWS["access_key_id"]}/', flow.request.headers['authorization'])
        self.assertTrue(callable(flow.request.stream))
        body = b'1;chunk-signature=' + b'0' * 64 + b'\r\na\r\n0;chunk-signature=' + b'0' * 64 + b'\r\n\r\n'
        out = flow.request.stream(body) + flow.request.stream(b'')
        self.assertEqual(len(out), len(body))
        self.assertNotIn(b'0' * 64, out)
        # The request hook comes after the body: it must not touch the request again.
        before = dict(flow.request.headers)
        asyncio.run(proxy.request(flow))
        self.assertEqual(flow.request.headers, before)
        # The buffered path re-signs the whole body.
        flow, killed = self.proxy_flow('PUT', host, '/key', headers, stream=False, content=body)
        asyncio.run(proxy.requestheaders(flow))
        asyncio.run(proxy.request(flow))
        self.assertEqual((len(flow.request.raw_content), flow.response), (len(body), None))
        self.assertNotIn(b'0' * 64, flow.request.raw_content)
        flow, killed = self.proxy_flow('PUT', host, '/key', headers, stream=False, content=b'garbage')
        responses = []
        with patch.object(self.module.EgressProxy, 'respond', staticmethod(lambda f, *a: responses.append(a[0]))):
            asyncio.run(proxy.request(flow))
        self.assertEqual(responses, [403])

    def test_chunked_pushes_stream_once_their_ref_updates_pass(self):
        proxy = self.proxy_with_cell()
        notes = []
        proxy.approvals.watchers.add(type('W', (), {'write': lambda self, b: notes.append(json.loads(b))})())
        headers = {'transfer-encoding': 'chunked', 'authorization': 'Basic eDphbmNoaS1wbGFjZWhvbGRlcg=='}

        def push(body, path='/o/r.git/git-receive-pack', hdrs=headers, cell=None, size=7):
            if cell is not None:
                proxy.registry.client_cell = lambda client: cell
            flow, killed = self.proxy_flow('POST', 'github.com', path, hdrs, stream=False)
            asyncio.run(proxy.requestheaders(flow))
            if not callable(flow.request.stream):
                return flow, None
            sent = [flow.request.stream(body[i : i + size]) for i in range(0, len(body), size)]
            sent.append(flow.request.stream(b''))
            from types import SimpleNamespace as NS

            def respond(f, status, content, headers=None):
                f.response = NS(status_code=status, content=content, headers=headers)

            with patch.object(self.module.EgressProxy, 'respond', staticmethod(respond)):
                proxy.response(flow)
            return flow, sent

        # Over HTTP/2 there is no transfer-encoding: the length is just missing.
        flow, sent = push(
            git_push((b'2' * 40, b'1' * 40, b'refs/heads/fix')), hdrs={'authorization': headers['authorization']}
        )
        self.assertIsNotNone(sent)
        pack = b'PACK' + bytes(range(256)) * 64
        body = git_push((b'2' * 40, b'1' * 40, b'refs/heads/fix'), pack=pack)
        flow, sent = push(body)
        self.assertNotEqual(flow.request.headers['authorization'], headers['authorization'])
        out = b''.join(b if isinstance(b, bytes) else b''.join(b) for b in sent)
        self.assertEqual(out, body)
        # Nothing leaves before the flush that ends the updates.
        flush = body.index(b'0000PACK') + 4
        self.assertEqual(sent[: (flush - 1) // 7], [[]] * ((flush - 1) // 7))
        self.assertEqual(sent[(flush - 1) // 7], [body[: ((flush - 1) // 7 + 1) * 7]])
        self.assertIsNone(flow.response)

        main = git_push(
            (b'2' * 40, b'1' * 40, b'refs/heads/fix'), (b'2' * 40, b'1' * 40, b'refs/heads/main'), pack=pack
        )
        flow, sent = push(main)
        self.assertTrue(all(b in ([], b'') for b in sent))
        self.assertEqual(flow.response.status_code, 200)
        report = flow.response.content
        self.assertIn(b'\x01000eunpack ok\n', report)
        self.assertIn(b'ng refs/heads/main anchi: push to main or master', report)
        self.assertIn(b'ng refs/heads/fix anchi:', report)
        self.assertEqual(notes[-1]['type'], 'notice')
        self.assertIn('update refs/heads/main', notes[-1]['text'])

        many = [(b'2' * 40, b'1' * 40, b'refs/heads/f%d' % i) for i in range(1000)]
        for body in (git_push(*many, pack=pack), body[:50], b'not a push at all'):
            flow, sent = push(body, size=4096)
            self.assertTrue(all(b in ([], b'') for b in sent))
            self.assertEqual(flow.response.status_code, 403)
        rows = [json.loads(line) for line in Path(self.tmp, 'audit.jsonl').read_text().splitlines()]
        pushes = [(r['decision'], r.get('risk')) for r in rows if r.get('event') == 'push']
        self.assertEqual(
            pushes,
            [('inject', None)] * 2 + [('deny', 'git-default-branch')] + [('deny', 'github-push-unreadable')] * 3,
        )
        self.assertEqual([r['decision'] for r in rows if r.get('push') == 'streamed'], ['inject'] * 6)

        # Buffered as before: with a length, when GitHub writes ask, or without GitHub.
        for hdrs, cell in (
            ({**headers, 'content-length': '10'}, None),
            ({**headers, 'content-encoding': 'gzip'}, None),
            (headers, self.module.Cell('t1', 'dev', {'github'}, ask={'github'})),
            (headers, self.module.Cell('t1', 'dev', {'aws'})),
        ):
            flow, sent = push(body, hdrs=hdrs, cell=cell)
            self.assertEqual((sent, flow.metadata), (None, {}))

    def test_other_streamed_requests_leave_uninjected_and_say_so(self):
        proxy = self.proxy_with_cell()
        flow, killed = self.proxy_flow('POST', 'api.github.com', '/repos/o/r/releases', {'authorization': 'x'}, True)
        asyncio.run(proxy.requestheaders(flow))
        self.assertEqual((killed, flow.request.headers), ([], {'authorization': 'x'}))
        host, headers = signed('s3', host='bucket.s3.amazonaws.com')
        flow, killed = self.proxy_flow('POST', host, '/bucket?delete', headers, True)

        async def denied(request):
            return 'denied'

        with patch.object(proxy.approvals, 'ask', denied):
            asyncio.run(proxy.requestheaders(flow))
        self.assertEqual(killed, [1])
        # Streaming that starts after the headers hook (a body without a length past 8 MiB that
        # does not stream from the start, such as a compressed push): too late to inject.
        late = {'authorization': 'x', 'content-encoding': 'gzip'}
        flow, killed = self.proxy_flow('POST', 'github.com', '/o/r.git/git-receive-pack', late, False)
        asyncio.run(proxy.requestheaders(flow))
        flow.request.stream = True
        asyncio.run(proxy.request(flow))
        self.assertEqual((flow.request.headers, flow.response), (late, None))
        rows = [json.loads(line) for line in Path(self.tmp, 'audit.jsonl').read_text().splitlines()]
        self.assertEqual([r['decision'] for r in rows], ['pass:streamed', 'held-denied', 'pass:streamed'])

    def test_quota_headers_of_runtime_responses_are_kept(self):
        from types import SimpleNamespace as NS

        proxy = self.proxy_with_cell()

        def response(rule, status, headers):
            flow = NS(metadata={'anchi-quota': rule} if rule else {}, response=NS(status_code=status, headers=headers))
            proxy.responseheaders(flow)

        response(
            'codex',
            200,
            {
                'X-Codex-Primary-Used-Percent': '38',
                'x-codex-primary-window-minutes': '300',
                'set-cookie': 'session=secret',
                'authorization': 'Bearer secret',
                'x-codex-bad': 'a\nb',
            },
        )
        response('anthropic', 429, {'anthropic-ratelimit-unified-status': 'rejected', 'retry-after': '120'})
        response(None, 200, {'x-codex-primary-used-percent': '99'})  # not a runtime response
        response('codex', 200, {'content-type': 'text/event-stream'})  # nothing new: kept as it was
        self.assertEqual(
            proxy.quota['codex']['headers'],
            {'x-codex-primary-used-percent': '38', 'x-codex-primary-window-minutes': '300'},
        )
        self.assertEqual(
            proxy.quota['anthropic'],
            {
                'ts': proxy.quota['anthropic']['ts'],
                'status': 429,
                'headers': {'anthropic-ratelimit-unified-status': 'rejected', 'retry-after': '120'},
            },
        )

    def test_a_credential_of_the_cells_own_is_reported_once_per_host(self):
        proxy = self.proxy_with_cell()
        lines = []
        proxy.approvals.watchers.add(type('W', (), {'write': lambda self, b: lines.append(json.loads(b))})())
        for host, auth in [
            ('api.example.com', 'Bearer sk-live-123'),
            ('api.example.com', 'Bearer sk-live-456'),
            ('example.org', 'Bearer anchi-placeholder'),
            ('example.org', None),
            ('other.example', 'token abc'),
        ]:
            flow, _ = self.proxy_flow('GET', host, '/v1/me?key=secret', {'authorization': auth} if auth else {}, False)
            asyncio.run(proxy.request(flow))
        self.assertEqual(
            lines,
            [
                {
                    'type': 'credential',
                    'task': 't1',
                    'agent': 'dev',
                    'method': 'GET',
                    'host': host,
                    'path': '/v1/me',
                }
                for host in ('api.example.com', 'other.example')
            ],
        )
        self.assertNotIn('sk-live', json.dumps(lines))

    def test_codex_rate_limit_messages_are_kept(self):
        from types import SimpleNamespace as NS

        proxy = self.proxy_with_cell()
        limits = {
            'type': 'codex.rate_limits',
            'plan_type': 'team',
            'rate_limits': {
                'allowed': True,
                'limit_reached': False,
                'primary': {'used_percent': 40, 'window_minutes': 300, 'reset_at': 1791500157, 'extra': 'x'},
                'secondary': {'used_percent': 76, 'window_minutes': 10080, 'reset_at': '1791995645'},
            },
        }

        def message(content, rule='codex', from_client=False):
            flow = NS(
                metadata={'anchi-quota': rule} if rule else {},
                websocket=NS(messages=[NS(from_client=from_client, content=content)]),
            )
            proxy.websocket_message(flow)

        message(json.dumps({**limits, 'plan_type': 'other'}).encode(), rule=None)  # not a runtime stream
        message(json.dumps({**limits, 'plan_type': 'other'}).encode(), from_client=True)
        message(b'{"type":"response.output_text.delta","delta":"codex.rate_limits"}')
        message(b'{"type":"codex.rate_limits", broken')
        self.assertNotIn('codex', proxy.quota)
        # The server puts `type` anywhere in the object.
        message(
            json.dumps(
                {'plan_type': 'team', 'rate_limits': limits['rate_limits'], 'type': 'codex.rate_limits'}
            ).encode()
        )
        self.assertEqual(
            proxy.quota['codex'],
            {
                'ts': proxy.quota['codex']['ts'],
                'status': 200,
                'headers': {},
                'plan': 'team',
                'limited': False,
                'windows': [
                    {'name': 'primary', 'used_percent': 40, 'window_minutes': 300, 'reset_at': 1791500157},
                    {'name': 'secondary', 'used_percent': 76, 'window_minutes': 10080, 'reset_at': None},
                ],
            },
        )
        limits['rate_limits']['limit_reached'] = True
        message(json.dumps(limits).encode())
        self.assertTrue(proxy.quota['codex']['limited'])

    def test_injected_runtime_requests_are_marked_for_quota(self):
        import time

        def fetch(request):
            if request.get('op') == 'codex_token':
                return {'access_token': 'real', 'account_id': 'acct', 'expires_at': time.time() + 3600}
            return GITHUB

        proxy = self.module.EgressProxy(
            registry=self.module.Registry(('127.0.0.1', 1)), credentials=self.module.Credentials(fetch)
        )
        cell = self.module.Cell('t1', 'dev', {'codex', 'github'})
        proxy.registry.client_cell = lambda client: cell
        flow, _ = self.proxy_flow(
            'POST', 'chatgpt.com', '/backend-api/codex/responses', {'authorization': 'Bearer anchi-placeholder'}, False
        )
        asyncio.run(proxy.request(flow))
        self.assertEqual(flow.metadata.get('anchi-quota'), 'codex')
        flow, _ = self.proxy_flow('GET', 'api.github.com', '/user', {'authorization': 'Bearer x'}, False)
        asyncio.run(proxy.request(flow))
        self.assertNotIn('anchi-quota', flow.metadata)

    def test_audit_never_contains_credentials(self):
        self.module.audit({'decision': 'inject', 'host': 'api.github.com'})
        text = Path(self.tmp, 'audit.jsonl').read_text()
        self.assertNotIn(GITHUB['token'], text)
        self.assertIn('"ts"', text)


class AuthEgressScopeTests(unittest.TestCase):
    def test_only_the_egress_caller_reads_connector_credentials(self):
        import server

        self.assertEqual(
            server.credential_ops('egress'), ('egress_credential', 'codex_token', 'codex_account', 'claude_token')
        )
        self.assertNotIn('egress_credential', server.credential_ops('inference'))
        self.assertEqual(server.credential_ops(None), ())

    def test_aws_import_validation(self):
        import auth
        from common import Denied

        with (
            tempfile.TemporaryDirectory() as store,
            patch.object(auth, 'STORE', Path(store)),
            patch.object(auth.vault, 'KEY', Path(store) / 'key'),
        ):
            Path(store, 'key').write_bytes(os.urandom(32))
            good = {'access_key_id': 'AKIAIOSFODNN7EXAMPLE', 'secret_access_key': 'a' * 40, 'region': 'us-west-2'}
            self.assertTrue(auth.import_aws(good)['connected'])
            self.assertEqual(auth.egress_credential('aws')['region'], 'us-west-2')
            for bad in (
                {**good, 'access_key_id': 'nope'},
                {**good, 'region': 'mars'},
                {**good, 'access_key_id': 'ASIAIOSFODNN7EXAMPLE'},
                {**good, 'extra': 1},
            ):
                with self.assertRaises(Denied):
                    auth.import_aws(bad)
            with self.assertRaises(Denied):
                auth.egress_credential('gmail')


if __name__ == '__main__':
    unittest.main()
