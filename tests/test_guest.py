import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('anchi_cell', Path(__file__).parents[1] / 'guest' / 'anchi_cell.py')
anchi_cell = importlib.util.module_from_spec(spec)
spec.loader.exec_module(anchi_cell)

MOUNTINFO = '\n'.join(
    [
        '22 1 254:1 / / rw,relatime - ext4 /dev/vda1 rw',
        '40 22 0:35 / /var/lib/anchi/agents/dev/home/workspaces/w rw - virtiofs mount0 rw',
        r'41 22 0:36 / /var/lib/anchi/agents/my\040agent rw - tmpfs tmpfs rw',
        '42 22 0:37 / /var/lib/anchi/agents/developer rw - tmpfs tmpfs rw',
        'short line',
    ]
)


class PurgeGuardTests(unittest.TestCase):
    def test_finds_mounts_at_or_below_a_path_only(self):
        self.assertEqual(
            anchi_cell.mounts_under(Path('/var/lib/anchi/agents/dev'), MOUNTINFO),
            ['/var/lib/anchi/agents/dev/home/workspaces/w'],
        )
        # A sibling sharing the prefix is not below the path; escapes are decoded.
        self.assertEqual(anchi_cell.mounts_under(Path('/var/lib/anchi/agents/dev/'), MOUNTINFO)[0][-1], 'w')
        self.assertEqual(
            anchi_cell.mounts_under(Path('/var/lib/anchi/agents/my agent'), MOUNTINFO),
            ['/var/lib/anchi/agents/my agent'],
        )
        self.assertEqual(anchi_cell.mounts_under(Path('/var/lib/anchi/agents/ops'), MOUNTINFO), [])


if __name__ == '__main__':
    unittest.main()


class AuditRowsTests(unittest.TestCase):
    def test_reads_one_task_across_rotated_files_newest_last(self):
        import json
        import tempfile

        tmp = Path(tempfile.mkdtemp())
        old, cur = tmp / 'audit.jsonl.1', tmp / 'audit.jsonl'
        row = lambda task, n: json.dumps({'task': task, 'n': n, 'host': 'h'}, sort_keys=True)  # noqa: E731
        old.write_text('\n'.join([row('t-a', 1), row('t-b', 2), 'not json', row('t-a', 3)]) + '\n')
        cur.write_text('\n'.join([row('t-a', 4), row('t-ab', 5)]) + '\n')
        found = anchi_cell.audit_rows('t-a', [old, cur, tmp / 'missing'])
        self.assertEqual([r['n'] for r in found['rows']], [1, 3, 4])
        self.assertEqual((found['total'], found['truncated']), (3, False))
        limited = anchi_cell.audit_rows('t-a', [old, cur], limit=2)
        self.assertEqual(([r['n'] for r in limited['rows']], limited['truncated']), ([3, 4], True))


class AccountArgumentTests(unittest.TestCase):
    def test_accounts_name_google_services_of_the_agent_only(self):
        self.assertEqual(anchi_cell.parse_accounts('-', ['gmail']), {})
        self.assertEqual(
            anchi_cell.parse_accounts('gmail=work,drive=personal', ['gmail', 'drive']),
            {'gmail': 'work', 'drive': 'personal'},
        )
        for arg, connectors in (
            ('gmail=work', ['drive']),
            ('notion=work', ['notion']),
            ('gmail=Work', ['gmail']),
            ('gmail=', ['gmail']),
            ('gmail=a,gmail=b', ['gmail']),
            ('gmail', ['gmail']),
        ):
            with self.assertRaises(anchi_cell.Failure):
                anchi_cell.parse_accounts(arg, connectors)


class StartCommandTests(unittest.TestCase):
    def test_start_takes_the_high_risk_argument_and_checks_it(self):
        from unittest.mock import patch

        seen = []
        args = ['anchi-cell', 'start', 't-1', 'dev', 'codex', 'base', 'github', 'cell', 'codex', '-', '-', '-', '-']
        with (
            patch.object(anchi_cell.os, 'getuid', lambda: 0),
            patch.object(anchi_cell, 'cell_start', lambda *a: seen.append(a)),
        ):
            anchi_cell.main(args)
            anchi_cell.main([*args, 'github-merge'])
            with self.assertRaises(anchi_cell.Failure):
                anchi_cell.main([*args, 'github-merge', 'extra'])
        self.assertEqual([len(a) for a in seen], [11, 12])
        self.assertEqual(seen[1][-1], 'github-merge')
        with self.assertRaises(anchi_cell.Failure) as refused:
            anchi_cell.cell_start('t-1', 'dev', 'codex', 'base', 'github', 'cell', 'codex', '-', '-', '-', '-', 'a b')
        self.assertEqual(str(refused.exception), 'BAD_HIGH_RISK')


class BaseImageTests(unittest.TestCase):
    def test_a_changed_build_script_or_runtime_pin_is_a_new_base(self):
        import tempfile
        from unittest.mock import patch

        root = Path(__file__).parents[1] / 'guest'
        with tempfile.TemporaryDirectory() as tmp:
            lib = Path(tmp)
            (lib / 'build-base.sh').write_bytes((root / 'anchi-build-base.sh').read_bytes())
            with patch.object(anchi_cell, 'LIB', lib), patch.object(anchi_cell, 'CELL_ENV', root / 'cell.env'):
                first = anchi_cell.base_version()
                self.assertRegex(first, r'^base-[0-9a-f]{12}$')
                (lib / 'build-base.sh').write_text('#!/bin/sh\necho changed\n')
                self.assertNotEqual(anchi_cell.base_version(), first)

    def test_the_build_script_reads_only_pins_from_cell_env(self):
        script = (Path(__file__).parents[1] / 'guest' / 'anchi-build-base.sh').read_text()
        env = (Path(__file__).parents[1] / 'guest' / 'cell.env').read_text()
        used = set(__import__('re').findall(r'\$\{?(ANCHI_[A-Z0-9_]+)', script))
        self.assertTrue({'ANCHI_GO_VERSION', 'ANCHI_RUST_VERSION', 'ANCHI_PNPM_VERSION'} <= used)
        for name in used:
            self.assertRegex(env, rf'(?m)^{name}=\S+$', name)


class RuntimeLayerTests(unittest.TestCase):
    """Each runtime is a layer of its own over the base, stacked above an agent's recipe."""

    def setUp(self):
        import json
        import tempfile
        from unittest.mock import patch

        self.json = json
        root = Path(__file__).parents[1] / 'guest'
        self.tmp = Path(tempfile.mkdtemp())
        self.lib = self.tmp / 'lib'
        self.lib.mkdir()
        (self.lib / 'build-base.sh').write_bytes((root / 'anchi-build-base.sh').read_bytes())
        for runtime in ('codex', 'claude-code', 'hermes'):
            name = f'build-runtime-{runtime}.sh'
            (self.lib / name).write_bytes((root / f'anchi-{name}').read_bytes())
        self.env = self.tmp / 'cell.env'
        self.env.write_text((root / 'cell.env').read_text())
        for patcher in (
            patch.object(anchi_cell, 'LIB', self.lib),
            patch.object(anchi_cell, 'CELL_ENV', self.env),
            patch.object(anchi_cell, 'LAYERS', self.tmp / 'layers'),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)

    def built(self, image, digest):
        layer = anchi_cell.layer_dir(image, digest)
        (layer / 'upper').mkdir(parents=True)
        (layer / 'meta.json').write_text(self.json.dumps({'ok': True, 'base': anchi_cell.base_version()}))
        return layer / 'upper'

    def test_layers_stack_runtime_over_recipe_over_base(self):
        base = self.built('codex', 'base')
        with self.assertRaises(anchi_cell.Failure) as missing:
            anchi_cell.lowerdirs('codex', 'base', 'hermes')
        self.assertEqual(str(missing.exception), 'RUNTIME_IMAGE_NOT_BUILT')
        hermes = self.built('runtime-hermes', 'runtime')
        recipe = self.built('node', 'a' * 16)
        self.assertEqual(
            anchi_cell.lowerdirs('node', 'a' * 16, 'hermes').split(':'),
            [str(hermes), str(recipe), str(base), str(anchi_cell.BASE)],
        )
        self.assertEqual(anchi_cell.lowerdirs('codex', 'base').split(':'), [str(base), str(anchi_cell.BASE)])

    def test_a_pin_names_a_new_layer_of_the_runtime_that_reads_it(self):
        hermes = anchi_cell.layer_dir('runtime-hermes', 'runtime')
        codex = anchi_cell.layer_dir('runtime-codex', 'runtime')
        base = anchi_cell.base_version()
        self.env.write_text(self.env.read_text().replace('ANCHI_HERMES_VERSION=', 'ANCHI_HERMES_VERSION=9'))
        self.assertNotEqual(anchi_cell.layer_dir('runtime-hermes', 'runtime'), hermes)
        self.assertEqual(anchi_cell.layer_dir('runtime-codex', 'runtime'), codex)
        self.assertEqual(anchi_cell.base_version(), base)
        # A new base is a new layer for every runtime built on it.
        (self.lib / 'build-base.sh').write_text('#!/bin/sh\necho changed\n')
        self.assertNotEqual(anchi_cell.layer_dir('runtime-codex', 'runtime'), codex)

    def test_runtime_layers_are_built_from_their_script_and_cannot_be_removed(self):
        for image, digest in (('runtime-hermes', 'base'), ('codex', 'runtime'), ('node', 'runtime')):
            with self.assertRaises(anchi_cell.Failure, msg=(image, digest)):
                anchi_cell.image_build(image, digest)
        with self.assertRaises(anchi_cell.Failure) as removed:
            anchi_cell.image_remove('runtime-codex')
        self.assertEqual(str(removed.exception), 'BASE_IMAGE_PROTECTED')

    def test_runtime_build_scripts_never_use_apt(self):
        for runtime in ('codex', 'claude-code', 'hermes'):
            script = (self.lib / f'build-runtime-{runtime}.sh').read_text()
            self.assertNotIn('apt-get', script, runtime)
            self.assertIn('sha256sum -c', script, runtime)
