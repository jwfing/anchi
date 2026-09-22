import sys
import tempfile
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'services'))
from unittest.mock import patch

import common
import connector_base
import connectors
from common import Denied
from ledger import Ledger


class RegistryTests(unittest.TestCase):
    def test_registry_shape(self):
        self.assertEqual(set(connectors.CONNECTORS), {'gmail', 'drive', 'notion', 'slack'})
        for name, connector in connectors.CONNECTORS.items():
            self.assertEqual(connector.id, name)
            self.assertEqual(connector.user, 'secure-' + name)
            self.assertTrue(connector.hosts)
            self.assertIn(connector.credential.split(':')[0], ('google', 'token'))
            for op, kind in connector.ops.items():
                self.assertTrue(op.startswith(name + '.'), op)
                self.assertIn(kind, (connectors.READ, connectors.WRITE))
            self.assertEqual(connector.ops[name + '.status'], connectors.READ)
        self.assertEqual(connectors.kind('drive.create'), connectors.WRITE)
        self.assertEqual(connectors.kind('gmail.list'), connectors.READ)
        self.assertIs(connectors.by_op('slack.post'), connectors.CONNECTORS['slack'])
        self.assertIs(connectors.by_user('secure-notion'), connectors.CONNECTORS['notion'])
        self.assertIsNone(connectors.by_user('secure-inference'))
        with self.assertRaisesRegex(Denied, 'OPERATION_DENIED'):
            connectors.by_op('drive.delete')
        self.assertEqual(connectors.SERVICE_USERS, ('secure-gmail', 'secure-drive', 'secure-notion', 'secure-slack'))


class LedgerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.ledger = Ledger(Path(self.temp.name) / 'writes.sqlite3', 'slack', limit_code='DAILY_WRITE_LIMIT')

    def test_begin_records_and_conflicts(self):
        self.assertIsNone(self.ledger.begin('a' * 32, 'digest1', model='slack.post'))
        with self.assertRaisesRegex(Denied, 'REQUEST_ALREADY_RUNNING'):
            self.ledger.begin('a' * 32, 'digest1')
        with self.assertRaisesRegex(Denied, 'REQUEST_ID_CONFLICT'):
            self.ledger.begin('a' * 32, 'other')
        self.ledger.mark('a' * 32, 'SUCCEEDED', result={'ts': '1'})
        self.assertEqual(self.ledger.begin('a' * 32, 'digest1'), {'ts': '1'})

    def test_waiting_resumes_unknown_never(self):
        self.ledger.begin('b' * 32, 'd')
        self.ledger.waiting('b' * 32)
        self.assertIsNone(self.ledger.begin('b' * 32, 'd'))
        self.ledger.mark('b' * 32, 'UNKNOWN', error='TIMEOUT')
        with self.assertRaisesRegex(Denied, 'REQUEST_ALREADY_UNKNOWN'):
            self.ledger.begin('b' * 32, 'd')
        self.assertEqual(self.ledger.get('b' * 32)['state'], 'UNKNOWN')

    def test_daily_limit_and_recover(self):
        for i in range(3):
            self.ledger.begin(f'{i:032x}', 'd', daily_limit=3)
            self.ledger.mark(f'{i:032x}', 'FAILED', error='x')
        with self.assertRaisesRegex(Denied, 'DAILY_WRITE_LIMIT'):
            self.ledger.begin('f' * 32, 'd', daily_limit=3)
        self.ledger.begin('e' * 32, 'd')
        self.ledger.recover()
        self.assertEqual(self.ledger.get('e' * 32)['state'], 'UNKNOWN')
        self.assertEqual(self.ledger.history(2)[0]['id'], 'e' * 32)
        self.assertEqual(
            set(self.ledger.history(1)[0]), {'id', 'provider', 'model', 'created', 'finished', 'state', 'error'}
        )


class TransportTests(unittest.TestCase):
    def setUp(self):
        self.calls = []

        def transport(host, method, path, headers, body):
            self.calls.append((host, method, path, headers, body))
            return self.response

        self.patch = patch('common.TRANSPORT', transport)
        self.patch.start()
        self.addCleanup(self.patch.stop)
        self.response = (200, b'{"ok": true}')

    def test_paths_are_allowlisted_per_connector(self):
        drive = connectors.CONNECTORS['drive']
        common.provider_request(drive, 'GET', '/drive/v3/files?q=x', token='T')
        self.assertEqual(self.calls[0][0], 'www.googleapis.com')
        self.assertEqual(self.calls[0][3]['Authorization'], 'Bearer T')
        for path in (
            '/drive/v3/files/../about',
            '/gmail/v1/users/me/messages',
            '//evil',
            '/drive/v3/files/x/permissions',
        ):
            with self.assertRaisesRegex(Denied, 'DESTINATION_DENIED'):
                common.provider_request(drive, 'GET', path, token='T')
        with self.assertRaisesRegex(Denied, 'DESTINATION_DENIED'):
            common.provider_request(drive, 'DELETE', '/drive/v3/files/x', token='T')
        self.assertEqual(len(self.calls), 1)

    def test_status_mapping_never_reflects_body(self):
        slack = connectors.CONNECTORS['slack']
        for status, code in (
            (401, 'PROVIDER_AUTH_REQUIRED'),
            (403, 'PROVIDER_AUTH_REQUIRED'),
            (429, 'PROVIDER_RATE_LIMITED'),
            (500, 'PROVIDER_REQUEST_FAILED'),
        ):
            self.response = (status, b'{"error":"SECRET_DETAIL"}')
            with self.assertRaises(Denied) as caught:
                common.provider_request(slack, 'GET', '/api/auth.test', token='T')
            self.assertEqual(str(caught.exception), code)
        self.response = (200, b'x' * (2 * 1024 * 1024 + 1))
        with self.assertRaisesRegex(Denied, 'PROVIDER_RESPONSE_TOO_LARGE'):
            common.provider_request(slack, 'GET', '/api/auth.test', token='T', raw=True)
        self.response = (200, b'not json')
        with self.assertRaisesRegex(Denied, 'PROVIDER_RESPONSE_INVALID'):
            common.provider_request(slack, 'GET', '/api/auth.test', token='T')


class FlowTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = patch('connector_base.LEDGER_ROOT', Path(self.temp.name))
        require = patch('connector_base.policy_client.require')
        root.start()
        self.require = require.start()
        self.addCleanup(root.stop)
        self.addCleanup(require.stop)
        self.slack = connectors.CONNECTORS['slack']

    def test_read_requires_policy_before_execute(self):
        self.require.side_effect = Denied('APPROVAL_REQUIRED:x')
        executed = []
        with self.assertRaisesRegex(Denied, 'APPROVAL_REQUIRED'):
            connector_base.read(self.slack, 'slack.channels', {'limit': 5}, 'gen', lambda: executed.append(1))
        self.assertEqual(executed, [])
        self.assertEqual(
            self.require.call_args.args[0], {'operation': 'slack.channels', 'account': 'gen', 'params': {'limit': 5}}
        )

    def test_write_waits_then_executes_once_and_never_replays_unknown(self):
        params = {'channel': 'C1', 'text': 'hi'}
        executed = []

        def execute(p):
            executed.append(p)
            return {'ts': '1'}

        self.require.side_effect = Denied('APPROVAL_REQUIRED:a')
        with self.assertRaisesRegex(Denied, 'APPROVAL_REQUIRED:a'):
            connector_base.write(self.slack, 'slack.post', params, 'gen', 'a' * 32, lambda p: p, execute)
        self.assertEqual(connector_base.ledger(self.slack).get('a' * 32)['state'], 'WAITING_APPROVAL')
        self.require.side_effect = None
        self.assertEqual(
            connector_base.write(self.slack, 'slack.post', params, 'gen', 'a' * 32, lambda p: p, execute), {'ts': '1'}
        )
        self.assertEqual(len(executed), 1)
        self.assertEqual(
            connector_base.write(self.slack, 'slack.post', params, 'gen', 'a' * 32, lambda p: p, execute), {'ts': '1'}
        )
        self.assertEqual(len(executed), 1)
        with self.assertRaisesRegex(Denied, 'REQUEST_ID_CONFLICT'):
            connector_base.write(
                self.slack, 'slack.post', {**params, 'text': 'changed'}, 'gen', 'a' * 32, lambda p: p, lambda p: {}
            )

        def boom(p):
            raise TimeoutError()

        with self.assertRaisesRegex(Denied, 'WRITE_EXECUTION_UNKNOWN'):
            connector_base.write(self.slack, 'slack.post', params, 'gen', 'b' * 32, lambda p: p, boom)
        with self.assertRaisesRegex(Denied, 'REQUEST_ALREADY_UNKNOWN'):
            connector_base.write(self.slack, 'slack.post', params, 'gen', 'b' * 32, lambda p: p, lambda p: {})
        with self.assertRaisesRegex(Denied, 'BAD_REQUEST_ID'):
            connector_base.write(self.slack, 'slack.post', params, 'gen', 'short', lambda p: p, lambda p: {})

    def test_prepare_output_is_what_gets_approved_and_denied_writes_fail(self):
        self.require.side_effect = Denied('APPROVAL_REQUIRED:z')
        with self.assertRaises(Denied):
            connector_base.write(
                self.slack,
                'slack.post',
                {'channel': 'C1', 'text': 'x'},
                'gen',
                'c' * 32,
                lambda p: {**p, 'expected': 'r1'},
                lambda p: {},
            )
        self.assertEqual(self.require.call_args.args[0]['params']['expected'], 'r1')
        self.require.side_effect = Denied('POLICY_DENIED')
        with self.assertRaisesRegex(Denied, 'POLICY_DENIED'):
            connector_base.write(
                self.slack, 'slack.post', {'channel': 'C1', 'text': 'x'}, 'gen', 'd' * 32, lambda p: p, lambda p: {}
            )
        self.assertEqual(connector_base.ledger(self.slack).get('d' * 32)['state'], 'FAILED')

    def test_frozen_metadata_survives_approval_retry_and_success(self):
        from unittest.mock import Mock

        prepare = Mock(return_value={'text': 'x', 'revision': 'r1'})
        execute = Mock(return_value={'id': 'done'})
        args = (self.slack, 'slack.post', {'text': 'x'}, 'gen', 'e' * 32, prepare, execute)
        self.require.side_effect = Denied('APPROVAL_REQUIRED:a')
        with self.assertRaises(Denied):
            connector_base.write(*args)
        prepare.side_effect = AssertionError('must not re-fetch changed metadata')
        self.require.side_effect = None
        self.assertEqual(connector_base.write(*args), {'id': 'done'})
        self.assertEqual(connector_base.write(*args), {'id': 'done'})
        execute.assert_called_once_with({'text': 'x', 'revision': 'r1'})
        self.assertEqual(prepare.call_count, 1)
        with self.assertRaisesRegex(Denied, 'REQUEST_ID_CONFLICT'):
            connector_base.write(self.slack, 'slack.post', {'text': 'changed'}, 'gen', 'e' * 32, prepare, execute)
        with self.assertRaisesRegex(Denied, 'REQUEST_ID_CONFLICT'):
            connector_base.write(self.slack, 'slack.post', {'text': 'x'}, 'new-account', 'e' * 32, prepare, execute)

    def test_uncertain_provider_responses_are_never_failed_or_replayed(self):
        for index, response in enumerate(
            ((200, b'not json'), (503, b'private upstream text'), (200, b'x' * (2 * 1024 * 1024 + 1)))
        ):
            request_id = f'{index:032x}'

            def execute(p):
                return common.provider_request(self.slack, 'POST', '/api/chat.postMessage', token='T', body=b'{}')

            with patch('common.TRANSPORT', return_value=response) as transport:
                args = (self.slack, 'slack.post', {'text': 'x'}, 'gen', request_id, lambda p: p, execute)
                with self.assertRaisesRegex(Denied, 'WRITE_EXECUTION_UNKNOWN'):
                    connector_base.write(*args)
                self.assertEqual(connector_base.ledger(self.slack).get(request_id)['state'], 'UNKNOWN')
                with self.assertRaisesRegex(Denied, 'REQUEST_ALREADY_UNKNOWN'):
                    connector_base.write(*args)
                transport.assert_called_once()

    def test_text_limit(self):
        text, truncated = connector_base.text_limit('中' * 20000, 40000)
        self.assertTrue(truncated)
        self.assertLessEqual(len(text.encode()), 40000)
        self.assertEqual(connector_base.text_limit('short'), ('short', False))


class ConnectorAdminTests(unittest.TestCase):
    def setUp(self):
        import auth
        import os

        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        key = Path(self.temp.name) / 'master.key'
        key.write_bytes(os.urandom(32))
        for p in (patch('auth.STORE', Path(self.temp.name)), patch('vault.KEY', key)):
            p.start()
            self.addCleanup(p.stop)
        self.auth = auth

    def test_probe_runs_as_connector_and_records_label(self):
        import connector_admin

        self.auth.import_token('slack', {'token': 'xoxb-' + '1' * 40})
        with (
            patch('connector_admin.run_as', side_effect=lambda user, fn: fn()),
            patch('connector_admin.credential_for', return_value='xoxb-token'),
            patch('connector_admin.module_for') as module,
        ):
            module.return_value.probe.return_value = 'Acme'
            self.assertEqual(connector_admin.probe('slack')['account'], 'Acme')
        module.return_value.probe.assert_called_once_with('xoxb-token')
        self.assertEqual(self.auth.status()['slack']['account'], 'Acme')

    def test_disconnect_paths(self):
        import connector_admin

        self.auth.import_token('slack', {'token': 'xoxb-' + '1' * 40})
        self.auth.import_token('notion', {'token': 'ntn_' + 'a' * 40})
        with (
            patch('connector_admin.run_as', side_effect=lambda user, fn: fn()),
            patch('connector_admin.credential_for', return_value='xoxb-token'),
            patch('connector_admin.module_for') as module,
            patch(
                'connector_admin.auth.disconnect', return_value={'connected': False, 'remote_revoked': True}
            ) as google,
        ):
            module.return_value.revoke.return_value = True
            self.assertEqual(
                connector_admin.disconnect('slack'), {'connector': 'slack', 'connected': False, 'remote_revoked': True}
            )
            module.return_value.revoke = None
            self.assertEqual(
                connector_admin.disconnect('notion')['manual_step'], 'remove the integration in Notion settings'
            )
            connector_admin.disconnect('drive')
            google.assert_called_once_with('drive')
        self.assertFalse(self.auth.status()['slack']['connected'])
        self.assertFalse(self.auth.status()['notion']['connected'])
        with self.assertRaises(Denied):
            connector_admin.disconnect('bogus')


class DeploymentConsistencyTests(unittest.TestCase):
    ROOT = Path(__file__).resolve().parents[1]

    def test_every_connector_has_units_bind_and_checks(self):
        cell_run = (self.ROOT / 'guest/cell-run').read_text()
        install = (self.ROOT / 'guest/install-gmail.sh').read_text()
        for connector in connectors.CONNECTORS.values():
            socket_unit = (self.ROOT / f'systemd/{connector.user}.socket').read_text()
            service_unit = (self.ROOT / f'systemd/{connector.user}.service').read_text()
            self.assertIn(f'ListenStream=/run/secure-{connector.id}/api.sock', socket_unit)
            self.assertIn('SocketGroup=secure-cell-peer', socket_unit)
            self.assertIn(f'server.py {connector.id}', service_unit)
            self.assertIn(f'User={connector.user}', service_unit)
            self.assertIn('InaccessiblePaths=/var/lib/secure-auth', service_unit)
            self.assertIn(f'--bind-ro=/run/secure-{connector.id}:/run/secure-{connector.id}', cell_run)
        # Users, groups and tmpfiles lines are generated from the registry, not typed by hand.
        self.assertIn('connectors.SERVICE_USERS', install)
        self.assertIn('check-connectors.py', (self.ROOT / 'scripts/up.sh').read_text())
        self.assertIn('check-connectors.py', (self.ROOT / 'scripts/verify.sh').read_text())


if __name__ == '__main__':
    unittest.main()
