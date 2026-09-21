import base64
import io
import json
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'services'))
import codex_admin
import codex_schema
import codex_transport
import inference
import network_rules
import pi_gateway
from common import Denied
from ledger import Ledger


class PiTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.config = self.root / 'pi.json'
        self.config.write_text(json.dumps({'provider': 'openai-codex', 'model': 'gpt-6-astra'}))
        self.patches = [
            patch('pi_gateway.CONFIG', self.config),
            patch('inference.DATABASE', self.root / 'runs.sqlite3'),
        ]
        for p in self.patches:
            p.start()
        self.request = {
            'op': 'pi_generate',
            'request_id': 'a' * 32,
            'instructions': 'Test',
            'input': [{'role': 'user', 'content': [{'type': 'input_text', 'text': 'test'}]}],
            'tools': [],
        }
        self.credential = {
            'access_token': 'SECRET',
            'account_id': 'account',
            'generation': 'generation',
            'expires_at': time.time() + 3600,
        }
        self.result = {
            'id': 'response1',
            'status': 'completed',
            'output': [{'type': 'message', 'content': [{'type': 'output_text', 'text': 'OK'}]}],
        }

    def tearDown(self):
        for p in self.patches:
            p.stop()
        self.temp.cleanup()

    def call(self):
        with patch('pi_gateway.rpc', return_value=self.credential):
            return pi_gateway.handle(self.request)

    def test_approval_before_network_and_resume(self):
        with (
            patch('policy_client.require', side_effect=Denied('APPROVAL_REQUIRED:id')),
            patch('codex_transport.responses') as network,
        ):
            with self.assertRaisesRegex(Denied, 'APPROVAL_REQUIRED'):
                self.call()
            network.assert_not_called()
        with (
            patch('policy_client.require') as permit,
            patch('codex_transport.responses', return_value=self.result) as network,
        ):
            self.assertEqual(self.call(), self.result)
            self.assertEqual(self.call(), self.result)
            self.assertEqual(network.call_count, 1)
            action = permit.call_args.args[0]
            self.assertEqual(action['operation'], 'inference.codex')
            self.assertEqual(action['account'], 'generation')
            self.assertNotIn('SECRET', json.dumps(action))
            self.assertEqual(action['params']['model'], 'gpt-6-astra')

    def test_changed_input_conflicts(self):
        with patch('policy_client.require'), patch('codex_transport.responses', return_value=self.result):
            self.call()
            self.request['instructions'] = 'changed'
            with self.assertRaisesRegex(Denied, 'REQUEST_ID_CONFLICT'):
                self.call()

    def test_interrupted_network_is_not_retried(self):
        with patch('policy_client.require'), patch('codex_transport.responses', side_effect=TimeoutError) as network:
            with self.assertRaisesRegex(Denied, 'CODEX_EXECUTION_UNKNOWN'):
                self.call()
            with self.assertRaisesRegex(Denied, 'REQUEST_ALREADY_UNKNOWN'):
                self.call()
            self.assertEqual(network.call_count, 1)

    def test_cannot_override_identity_model_destination_or_approval(self):
        for field in ('model', 'url', 'account', 'headers', 'approved'):
            with self.subTest(field=field), self.assertRaises(Denied):
                pi_gateway.handle({**self.request, field: 'forged'})

    def test_no_hosted_tools_or_remote_content(self):
        for tool in (
            {'type': 'web_search', 'name': 'read', 'parameters': {}},
            {'type': 'function', 'name': 'gmail_send', 'parameters': {}},
        ):
            with self.assertRaises(Denied):
                codex_schema.validate_parts('test', self.request['input'], [tool])
        for kind in ('input_image', 'input_file'):
            with self.assertRaises(Denied):
                codex_schema.validate_parts(
                    'test', [{'role': 'user', 'content': [{'type': kind, 'image_url': 'https://evil.test'}]}], []
                )

    def test_desktop_file_tool_reaches_approval_with_full_tool_set(self):
        self.request['tools'] = [
            {'type': 'function', 'name': name, 'parameters': {'type': 'object'}}
            for name in sorted(codex_schema.TOOL_NAMES)
        ]
        self.assertEqual(len(self.request['tools']), 19)
        with (
            patch('policy_client.require', side_effect=Denied('APPROVAL_REQUIRED:id')),
            patch('codex_transport.responses') as network,
        ):
            with self.assertRaisesRegex(Denied, 'APPROVAL_REQUIRED'):
                self.call()
            network.assert_not_called()
        codex_schema.validate_parts(
            'test',
            [{'type': 'function_call', 'call_id': 'c1', 'name': 'host_files', 'arguments': '{}'}],
            self.request['tools'],
        )
        with self.assertRaises(Denied):
            codex_schema.validate_parts(
                'test', self.request['input'], self.request['tools'] + [self.request['tools'][0]]
            )

    def test_cjk_context_is_measured_in_utf8_bytes(self):
        message = lambda text: [{'role': 'user', 'content': [{'type': 'input_text', 'text': text}]}]
        codex_schema.validate_parts('t', message('你' * 14000), [])  # 42000 bytes; escaped ASCII would be 84000
        with self.assertRaisesRegex(Denied, 'CONTEXT_TOO_LARGE'):
            codex_schema.validate_parts('t', message('你' * 15000), [])

    def test_refresh_pins_public_addresses_atomically(self):
        with tempfile.TemporaryDirectory() as directory:
            targets = Path(directory) / 'targets.json'
            info = lambda host, *args, **kwargs: [
                (None, None, None, None, ('2606:4700::1111' if host == 'chatgpt.com' else '142.250.0.1', 443))
            ]
            with (
                patch('network_rules.TARGETS', targets),
                patch('network_rules.socket.getaddrinfo', side_effect=info),
                patch('network_rules.nft') as nft,
            ):
                network_rules.refresh()
                value = json.loads(targets.read_text())
                self.assertEqual(value['gmail.googleapis.com']['addresses'], ['142.250.0.1'])
                self.assertGreater(value['chatgpt.com']['expires_at'], time.time())
                commands = nft.call_args.args[0]
                self.assertIn('flush set inet secure_vm codex6', commands)
                self.assertIn('add element inet secure_vm codex6 { 2606:4700::1111 timeout 5m }', commands)
                self.assertIn('add element inet secure_vm gmail4 { 142.250.0.1 timeout 5m }', commands)
            private = lambda *args, **kwargs: [(None, None, None, None, ('10.0.0.5', 443))]
            targets.unlink()
            with (
                patch('network_rules.TARGETS', targets),
                patch('network_rules.socket.getaddrinfo', side_effect=private),
                patch('network_rules.nft') as nft,
            ):
                with self.assertRaises(RuntimeError):
                    network_rules.refresh()
                nft.assert_not_called()
                self.assertFalse(targets.exists())

    def test_oversized_context_denied(self):
        self.request['input'][0]['content'][0]['text'] = 'x' * 45000
        with self.assertRaisesRegex(Denied, 'CONTEXT_TOO_LARGE'):
            self.call()

    def test_model_daily_limit(self):
        with Ledger(inference.DATABASE, 'x').database() as conn:
            conn.executemany(
                'INSERT INTO runs(id,digest,provider,model,created,state) VALUES(?,?,?,?,?,?)',
                [(str(i), 'x', 'openai-codex', 'm', time.time(), 'FAILED') for i in range(50)],
            )
        with patch('codex_transport.responses') as network:
            with self.assertRaisesRegex(Denied, 'DAILY_REQUEST_LIMIT'):
                self.call()
            network.assert_not_called()

    def test_subscription_token_import_validation(self):
        claims = {'exp': time.time() + 3600, 'https://api.openai.com/auth': {'chatgpt_account_id': 'account'}}
        token = 'header.' + base64.urlsafe_b64encode(json.dumps(claims).encode()).decode() + '.signature'
        value = {'access_token': token, 'account_id': 'account', 'model': 'gpt-6-astra'}
        self.assertEqual(codex_admin.validate(value)['account_id'], 'account')
        for change in ({'account_id': 'other'}, {'access_token': 'sk-' + 'x' * 100}, {'refresh_token': 'DO_NOT_COPY'}):
            with self.assertRaises(Denied):
                codex_admin.validate({**value, **change})
        claims['exp'] = 0
        value['access_token'] = (
            'header.' + base64.urlsafe_b64encode(json.dumps(claims).encode()).decode() + '.signature'
        )
        with self.assertRaisesRegex(Denied, 'EXPIRED'):
            codex_admin.validate(value)

    def test_sse_done_with_missing_content_type(self):
        class Response(io.BytesIO):
            status = 200

            def getheader(self, *args):
                return ''

        data = b'data: ' + json.dumps({'type': 'response.done', 'response': self.result}).encode() + b'\n\n'
        self.assertEqual(codex_transport.read_response(Response(data)), self.result)

    def test_sse_incomplete_never_success(self):
        class Response(io.BytesIO):
            status = 200

            def getheader(self, *args):
                return 'text/event-stream'

        with self.assertRaises(RuntimeError):
            codex_transport.read_response(Response(b'data: [DONE]\n'))

    def test_provider_errors_do_not_reflect_body(self):
        class Response(io.BytesIO):
            status = 401

        with self.assertRaises(Denied) as caught:
            codex_transport.read_response(Response(b'SECRET_ACCESS_TOKEN'))
        self.assertNotIn('SECRET', str(caught.exception))

    def test_roles_include_every_connector(self):
        import connectors

        for connector in connectors.CONNECTORS.values():
            self.assertEqual(network_rules.ROLES[connector.id], (connector.user, connector.hosts[0]))
        self.assertEqual(network_rules.ROLES['codex'], ('secure-inference', 'chatgpt.com'))

    def test_tool_names_cover_connector_tools(self):
        import subprocess

        script = "import {ALL_TOOL_NAMES} from './pi/connectors.mjs'; console.log(JSON.stringify(ALL_TOOL_NAMES))"
        names = json.loads(
            subprocess.run(
                ['node', '--input-type=module', '-e', script],
                cwd=Path(__file__).resolve().parents[1],
                capture_output=True,
                text=True,
                check=True,
            ).stdout
        )
        self.assertTrue(set(names) <= codex_schema.TOOL_NAMES)
        self.assertEqual(len(names), 14)

    def test_multiple_provider_allow_rules_precede_reject(self):
        class User:
            def __init__(self, uid):
                self.pw_uid = uid

        users = {
            'secure-auth': 1,
            'secure-gmail': 2,
            'secure-inference': 3,
            'secure-policy': 4,
            'secure-drive': 5,
            'secure-notion': 6,
            'secure-slack': 7,
        }
        with (
            patch('network_rules.pwd.getpwnam', side_effect=lambda name: User(users[name])),
            patch('network_rules.subprocess.run') as run,
            patch('network_rules.nft') as nft,
        ):
            run.return_value.returncode = 1
            network_rules.initialize()
            rules = nft.call_args.args[0]
            self.assertLess(rules.index('meta skuid 3 ip daddr @codex4'), rules.index('meta skuid 3 counter reject'))
            self.assertLess(rules.index('meta skuid 3 ip6 daddr @model6'), rules.index('meta skuid 3 counter reject'))
