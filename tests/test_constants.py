"""guest/cell.env is the single source for cell identity and pinned versions."""

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
        text = (ROOT / 'lima/anchi-vm.yaml').read_text()
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
        # Every host script takes the VM name, ANCHI_INSTALL_VM included, from vm-name.sh.
        self.assertIn('ANCHI_INSTALL_VM', (ROOT / 'scripts/vm-name.sh').read_text())
        for script in ('up.sh', 'install-anchi.sh', 'verify.sh', 'cell.sh', 'policy.sh'):
            self.assertIn('anchi_vm_name', (ROOT / 'scripts' / script).read_text(), script)

    def test_release_archive_has_every_script_its_scripts_source(self):
        # A packaged script that sources one left out fails only after installing the release.
        text = (ROOT / 'scripts/package-release.sh').read_text()
        copy = next(line for line in text.splitlines() if line.startswith('cp scripts/up.sh '))
        packaged = {Path(word).name for word in copy.split()[1:-1]}
        for name in sorted(packaged):
            if not name.endswith('.sh'):
                continue
            for sourced in re.findall(r'^\s*source scripts/(\S+)', (ROOT / 'scripts' / name).read_text(), re.M):
                self.assertIn(sourced, packaged, f'{name} sources scripts/{sourced}')
        self.assertIn('vm-size.sh', packaged)

    def test_installers_clear_their_staging_directory_before_copying(self):
        # A VM keeps /tmp between releases; a stale copy would reinstall files a release removed.
        for script, stage in (('up.sh', '/tmp/secure-vm-bootstrap'), ('install-anchi.sh', '$stage')):
            text = (ROOT / 'scripts' / script).read_text()
            self.assertRegex(text, rf'rm -rf {re.escape(stage)} && mkdir -p', script)

    def test_guest_installer_names_a_wrong_cell_peer_gid(self):
        # Under set -e a bare test exits silently; the message names both gids.
        text = (ROOT / 'guest/install-gmail.sh').read_text()
        self.assertIn('secure-cell-peer has gid $peer_gid, expected $agent_host_uid', text)

    def test_release_archive_ships_the_anchi_skill(self):
        self.assertIn('cp -R skills/anchi "$root/skills/"', (ROOT / 'scripts/package-release.sh').read_text())
        self.assertIn('skills/anchi/SKILL.md', (ROOT / 'scripts/check-release.py').read_text())
        self.assertIn('current/skills/anchi', (ROOT / 'skills/README.md').read_text())


if __name__ == '__main__':
    unittest.main()


class ConnectorListTests(unittest.TestCase):
    """The proxy connectors are listed in Python (proxy, auth, vault, cell manager) and in
    TypeScript (config schema, protocol); a connector missing from one of them fails late."""

    @staticmethod
    def ts_list(path, name):
        text = (ROOT / path).read_text()
        body = re.search(rf'\b{name}(?:: [^=]+)? = \[([^\]]*)\]', text)
        assert body, f'{name} not found in {path}'
        return re.findall(r"'([a-z0-9-]+)'", body.group(1))

    def test_proxy_connectors_agree(self):
        import importlib.util

        import auth
        import egress_rules
        import vault

        spec = importlib.util.spec_from_file_location('anchi_cell', ROOT / 'guest/anchi_cell.py')
        anchi_cell = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(anchi_cell)
        connectors = list(egress_rules.CONNECTORS)
        self.assertEqual(self.ts_list('anchi/packages/core/src/config/schema.ts', 'PROXY_CONNECTORS'), connectors)
        self.assertEqual(self.ts_list('anchi/packages/protocol/src/rpc.ts', 'CONNECTOR_IDS'), connectors)
        self.assertEqual(list(anchi_cell.PROXY_CONNECTORS), connectors)
        self.assertEqual(set(auth.EGRESS_CONNECTORS), set(connectors))
        tokens = self.ts_list('anchi/packages/protocol/src/rpc.ts', 'TOKEN_CONNECTOR_IDS')
        self.assertEqual(set(tokens), set(connectors) - {'aws'})
        self.assertTrue(set(tokens) <= set(auth.TOKENS))
        for connector in connectors:
            self.assertIn(auth.EGRESS_CONNECTORS[connector], vault.NAMES, connector)
            self.assertIn(connector, egress_rules.VERIFY_ENDPOINTS, connector)
            self.assertIn(connector, egress_rules.BASE_EGRESS, connector)
            self.assertTrue(any(r.grant == connector for r in egress_rules.RULES), connector)
        # The credential scan of a cell looks for every connector's real values.
        source = (ROOT / 'guest/anchi_cell.py').read_text()
        for connector in connectors:
            self.assertIn(f"('{connector}', '{connector}.json'", source, connector)

    def test_high_risk_ids_agree(self):
        import egress_rules

        self.assertEqual(
            self.ts_list('anchi/packages/core/src/config/schema.ts', 'HIGH_RISK_IDS'),
            [entry[0] for entry in egress_rules.HIGH_RISK],
        )


class InCellUidTests(unittest.TestCase):
    """The agent's uid inside a cell is `SECURE_CELL_AGENT_UID` in cell.env; nothing else may
    spell it out, so a changed pin reaches `exec`, the base image and the live checks."""

    def test_in_cell_uid_is_never_hard_coded(self):
        pattern = re.compile(r"(?:--setuid=|--setgid=|-o |-g |-u )1000\b|startswith\('1000")
        offenders = []
        for file in sorted((ROOT / 'guest').iterdir()):
            if file.suffix in ('.py', '.sh') and pattern.search(file.read_text(errors='ignore')):
                offenders.append(str(file.relative_to(ROOT)))
        self.assertEqual(offenders, [])
        # The base build reads the pin from the build environment the cell manager exports.
        self.assertIn('"$SECURE_CELL_AGENT_UID"', (ROOT / 'guest/anchi-build-base.sh').read_text())
        manager = (ROOT / 'guest/anchi_cell.py').read_text()
        self.assertIn("k == 'SECURE_CELL_AGENT_UID'", manager)
        self.assertIn('|SECURE_CELL_AGENT_UID)', manager)  # a changed pin names a new layer
