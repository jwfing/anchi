"""guest/cell.env is the single source for cell identity and pinned versions."""

import json
from pathlib import Path
import re
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'services'))
import common


class CellEnvTests(unittest.TestCase):
    def test_env_parses_and_derives_host_uid(self):
        values = common.load_cell_env([ROOT / 'guest/cell.env'])
        self.assertEqual(int(values['SECURE_CELL_UID_BASE']), common.CELL_UID_BASE)
        self.assertEqual(common.CELL_AGENT_HOST_UID, common.CELL_UID_BASE + common.CELL_AGENT_UID)
        self.assertTrue(0 < common.CELL_AGENT_UID < common.CELL_UID_COUNT)
        with self.assertRaises(RuntimeError):
            common.load_cell_env([ROOT / 'guest/missing.env'])

    def test_node_sha_per_architecture(self):
        values = common.load_cell_env([ROOT / 'guest/cell.env'])
        self.assertNotIn('SECURE_NODE_SHA256', values)
        for key in ('SECURE_NODE_SHA256_ARM64', 'SECURE_NODE_SHA256_X64'):
            self.assertRegex(values[key], '^[a-f0-9]{64}$')
        self.assertNotEqual(values['SECURE_NODE_SHA256_ARM64'], values['SECURE_NODE_SHA256_X64'])

    def test_arch_helpers(self):
        def run(function, argument):
            return subprocess.run(
                ['bash', '-c', f'set -e; source guest/cell.env; source guest/arch.sh; {function} {argument}'],
                cwd=ROOT,
                capture_output=True,
                text=True,
            )

        self.assertEqual(run('node_arch', 'aarch64').stdout.strip(), 'arm64')
        self.assertEqual(run('node_arch', 'x86_64').stdout.strip(), 'x64')
        self.assertNotEqual(run('node_arch', 'riscv64').returncode, 0)
        values = common.load_cell_env([ROOT / 'guest/cell.env'])
        self.assertEqual(run('node_sha256', 'x64').stdout.strip(), values['SECURE_NODE_SHA256_X64'])
        self.assertEqual(run('host_vm_type', 'Darwin').stdout.strip(), 'vz')
        self.assertEqual(run('host_vm_type', 'Linux').stdout.strip(), 'qemu')
        self.assertNotEqual(run('host_vm_type', 'Windows_NT').returncode, 0)

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


class LimaTemplateTests(unittest.TestCase):
    def test_single_template_lists_both_architectures_without_fixed_driver(self):
        text = (ROOT / 'lima/secure-vm.yaml').read_text()
        top_level = [
            line.split(':')[0]
            for line in text.splitlines()
            if line and not line[0].isspace() and not line.startswith('#')
        ]
        self.assertNotIn('vmType', top_level)
        self.assertNotIn('arch', top_level)
        self.assertIn('sha256:7df0201546f75b8bcc1044594c806c35749421ad3c9bc1be2a3ab806cfae39cc', text)
        self.assertIn('sha256:ffe6203da54deeb6db5d2a98a83f9ec8e55f149d3f7ba622e1abe5fa966ee3d6', text)
        self.assertIn('arch: aarch64', text)
        self.assertIn('arch: x86_64', text)
        self.assertIn('mounts: []', text)

    def test_up_script_passes_explicit_vm_type(self):
        text = (ROOT / 'scripts/up.sh').read_text()
        self.assertIn('host_vm_type', text)
        self.assertIn('--vm-type="$vm_type"', text)
        self.assertIn('ANCHI_INSTALL_VM', (ROOT / 'scripts/verify.sh').read_text())


if __name__ == '__main__':
    unittest.main()
