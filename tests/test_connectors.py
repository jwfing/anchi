import sys
import tempfile
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'services'))
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


if __name__ == '__main__':
    unittest.main()
