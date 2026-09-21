"""guest/cell.env is the single source for cell identity and pinned versions."""

import json
from pathlib import Path
import re
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'services'))
import common


class CellEnvTests(unittest.TestCase):
    def test_env_parses_and_derives_host_uid(self):
        values = common.load_cell_env([ROOT / 'guest/cell.env'])
        self.assertEqual(common.CELL_AGENT_HOST_UID, common.CELL_UID_BASE + common.CELL_AGENT_UID)
        self.assertTrue(0 < common.CELL_AGENT_UID < common.CELL_UID_COUNT)
        self.assertRegex(values['SECURE_NODE_SHA256'], '^[a-f0-9]{64}$')
        with self.assertRaises(RuntimeError):
            common.load_cell_env([ROOT / 'guest/missing.env'])

    def test_pi_version_matches_lockfile(self):
        package = json.loads((ROOT / 'pi/package.json').read_text())
        self.assertEqual(package['dependencies']['@earendil-works/pi-coding-agent'], common.PI_VERSION)
        self.assertEqual(package['dependencies']['@earendil-works/pi-ai'], common.PI_VERSION)

    def test_no_hardcoded_cell_uids_outside_env(self):
        pattern = re.compile(r'\b52[45]288\b')
        offenders = []
        for folder in ('services', 'guest', 'scripts', 'systemd'):
            for file in sorted((ROOT / folder).iterdir()):
                if file.is_file() and file.name != 'cell.env' and pattern.search(file.read_text(errors='ignore')):
                    offenders.append(str(file.relative_to(ROOT)))
        self.assertEqual(offenders, [])


if __name__ == '__main__':
    unittest.main()
