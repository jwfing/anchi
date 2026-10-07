"""Agent-team egress proxy decisions, credential cache and cell registry; fake credentials only."""

import asyncio
import base64
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'services'))
import egress_rules as rules

GITHUB = {'token': 'ghp_fakefakefakefakefakefake', 'generation': 'g'}
CODEX = {'token': 'fake-codex-access', 'account_id': 'acct-123'}
LINEAR = {'token': 'lin_api_fakefakefakefakefake', 'generation': 'g'}
AWS = {
    'access_key_id': 'AKIAFAKEREAL00000000',
    'secret_access_key': 'fake/secret/key/0000000000',
    'region': 'us-east-1',
}
ALL = {'github', 'aws', 'linear', 'codex'}


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

    def test_aws_streaming_uploads_rejected(self):
        host, headers = signed('s3', host='bucket.s3.amazonaws.com')
        headers['x-amz-content-sha256'] = 'STREAMING-AWS4-HMAC-SHA256-PAYLOAD'
        decision = decide('PUT', host, '/key', headers)
        with self.assertRaises(ValueError):
            rules.apply(decision, 'PUT', f'https://{host}/key', headers, b'', AWS)

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

    def test_register_validates_names_and_connectors(self):
        registry = self.module.Registry(('127.0.0.1', 1))
        for request in (
            {'task': '../x', 'agent': 'a', 'connectors': []},
            {'task': 't', 'agent': 'A', 'connectors': []},
            {'task': 't', 'agent': 'a', 'connectors': ['gmail']},
            {'task': 't', 'agent': 'a', 'connectors': 'github'},
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

    def test_audit_never_contains_credentials(self):
        self.module.audit({'decision': 'inject', 'host': 'api.github.com'})
        text = Path(self.tmp, 'audit.jsonl').read_text()
        self.assertNotIn(GITHUB['token'], text)
        self.assertIn('"ts"', text)


class AuthEgressScopeTests(unittest.TestCase):
    def test_only_the_egress_caller_reads_connector_credentials(self):
        import server

        self.assertEqual(server.credential_ops('egress'), ('egress_credential', 'codex_token', 'codex_account'))
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
            good = {'access_key_id': 'AKIAABCDEFGHIJKLMNOP', 'secret_access_key': 'a' * 40, 'region': 'us-west-2'}
            self.assertTrue(auth.import_aws(good)['connected'])
            self.assertEqual(auth.egress_credential('aws')['region'], 'us-west-2')
            for bad in (
                {**good, 'access_key_id': 'nope'},
                {**good, 'region': 'mars'},
                {**good, 'access_key_id': 'ASIAABCDEFGHIJKLMNOP'},
                {**good, 'extra': 1},
            ):
                with self.assertRaises(Denied):
                    auth.import_aws(bad)
            with self.assertRaises(Denied):
                auth.egress_credential('gmail')


if __name__ == '__main__':
    unittest.main()
