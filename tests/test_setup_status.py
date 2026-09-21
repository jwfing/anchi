import json
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'services'))
import auth
import setup_status


class SetupStatusTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        (root / 'store').mkdir()
        self.key = root / 'master.key'
        self.patches = [
            patch('setup_status.ROOTFS', root / 'rootfs'),
            patch('setup_status.CELL_RUN', root / 'cell-run'),
            patch('setup_status.CONFIG', root / 'pi.json'),
            patch('setup_status.INSTALLED', root / 'installed.json'),
            patch('auth.STORE', root / 'store'),
            patch('vault.KEY', self.key),
        ]
        for p in self.patches:
            p.start()
            self.addCleanup(p.stop)
        self.root = root

    def test_fresh_guest_reports_nothing_installed(self):
        self.assertEqual(
            setup_status.status(),
            {
                'installed': False,
                'unlocked': False,
                'configured': False,
                'model': None,
                'expires_at': None,
                'runtime_version': None,
            },
        )

    def test_installed_configured_and_version(self):
        (self.root / 'rootfs/opt/secure-pi').mkdir(parents=True)
        (self.root / 'rootfs/opt/secure-pi/host-files.mjs').write_text('')
        (self.root / 'cell-run').write_text('')
        (self.root / 'installed.json').write_text(json.dumps({'runtime_version': '0.1.1'}))
        (self.root / 'pi.json').write_text(json.dumps({'provider': 'openai-codex', 'model': 'gpt-test'}))
        self.key.write_bytes(os.urandom(32))
        auth.write('codex.json', {'access_token': 'SECRET', 'expires_at': time.time() + 3600})
        value = setup_status.status()
        self.assertTrue(value['installed'] and value['unlocked'] and value['configured'])
        self.assertEqual((value['model'], value['runtime_version']), ('gpt-test', '0.1.1'))
        self.assertNotIn('SECRET', json.dumps(value))
        auth.write('codex.json', {'access_token': 'SECRET', 'expires_at': time.time() + 30})
        self.assertFalse(setup_status.status()['configured'])
        (self.root / 'installed.json').write_text('not json')
        self.assertIsNone(setup_status.status()['runtime_version'])


if __name__ == '__main__':
    unittest.main()
