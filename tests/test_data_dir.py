import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location(
    'anchi_data_dir', Path(__file__).parents[1] / 'guest' / 'anchi_data_dir.py'
)
data_dir = importlib.util.module_from_spec(spec)
spec.loader.exec_module(data_dir)


class ValidateTest(unittest.TestCase):
    def test_accepts_a_directory_on_another_disk(self):
        self.assertEqual(data_dir.validate('/data/anchi', '/data/home'), Path('/data/anchi'))

    def test_refuses_paths_that_are_not_plain_absolute_or_safe(self):
        for path in [
            'data/anchi',
            '/data/../etc',
            '/data/./anchi',
            '/data//anchi',
            '/data/an chi',
            '/data/anchi;rm',
            '/data',
            '/var/lib/anchi',
            '/var/lib/anchi/agents',
            '/var/lib',
            '/data/home',
            '/data/home/anchi',
        ]:
            with self.subTest(path=path), self.assertRaises(data_dir.Refused) as caught:
                data_dir.validate(path, '/data/home')
            self.assertEqual(caught.exception.code, 'BAD_DATA_DIR')


class UnitsTest(unittest.TestCase):
    def test_mounts_the_directory_at_var_lib_anchi_after_its_disk(self):
        unit = data_dir.mount_unit(Path('/data/anchi'))
        self.assertIn('What=/data/anchi\n', unit)
        self.assertIn('Where=/var/lib/anchi\n', unit)
        self.assertIn('Options=bind\n', unit)
        self.assertIn('RequiresMountsFor=/data/anchi\n', unit)
        self.assertIn('Before=anchi-egress.service\n', unit)
        self.assertEqual(data_dir.unit_directory(unit), '/data/anchi')

    def test_keeps_the_egress_proxy_out_of_the_new_path(self):
        dropin = data_dir.egress_dropin(Path('/data/anchi'))
        self.assertIn('[Service]\nInaccessiblePaths=/data/anchi\n', dropin)


class ApplyTest(unittest.TestCase):
    """apply() against a temporary tree: /var/lib/anchi, /etc/systemd and the new directory."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.target = root / 'var-lib-anchi'
        (self.target / 'agents' / 'dev' / 'home').mkdir(parents=True)
        (self.target / 'agents' / 'dev' / 'home' / 'notes.md').write_text('kept')
        (self.target / 'layers').mkdir()
        self.dest = root / 'data' / 'anchi'
        self.unit = root / 'etc' / 'var-lib-anchi.mount'
        self.dropin = root / 'etc' / 'anchi-egress.service.d' / 'anchi-data-dir.conf'
        self.mounted = False
        self.calls = []
        self.fail_enable = False
        patches = [
            mock.patch.object(data_dir, 'TARGET', self.target),
            mock.patch.object(data_dir, 'UNIT', self.unit),
            mock.patch.object(data_dir, 'EGRESS_DROPIN', self.dropin),
            mock.patch.object(data_dir, 'filesystem', lambda path: 'ext2/ext3'),
            mock.patch.object(data_dir, 'live_cells', lambda: []),
            mock.patch.object(data_dir.os, 'chown', lambda *a: None),
            mock.patch.object(data_dir.os.path, 'ismount', self.ismount),
            mock.patch.object(data_dir, 'systemctl', self.systemctl),
            mock.patch.object(data_dir.subprocess, 'run', self.fake_run),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        self.addCleanup(self.tmp.cleanup)

    real_run = staticmethod(subprocess.run)

    def ismount(self, path):
        return Path(path) == self.target and self.mounted

    def systemctl(self, *args):
        self.calls.append(args)
        if args[:2] == ('enable', '--now'):
            if self.fail_enable:
                raise subprocess.CalledProcessError(1, 'systemctl', stderr='mount failed')
            if self.mounted:
                return
            # A bind mount: /var/lib/anchi shows the new directory's files.
            self.target.rmdir()
            self.target.symlink_to(self.dest)
            self.mounted = True

    def fake_run(self, args, **kwargs):
        if args[0] == 'systemctl':
            self.calls.append(tuple(args[1:]))
            if args[1:3] == ['disable', '--now'] and self.target.is_symlink():
                self.target.unlink()
                self.target.mkdir()
                self.mounted = False
            return subprocess.CompletedProcess(args, 0, '', '')
        return self.real_run(args, **kwargs)

    def test_moves_the_data_mounts_it_and_removes_the_old_copy(self):
        result = data_dir.apply(self.dest)
        self.assertEqual(result['data_dir'], str(self.dest))
        self.assertEqual((self.dest / 'agents' / 'dev' / 'home' / 'notes.md').read_text(), 'kept')
        self.assertEqual((self.target / 'agents' / 'dev' / 'home' / 'notes.md').read_text(), 'kept')
        self.assertFalse(self.target.with_name('var-lib-anchi.moving').exists())
        self.assertEqual(data_dir.unit_directory(self.unit.read_text()), str(self.dest))
        self.assertIn(f'InaccessiblePaths={self.dest}', self.dropin.read_text())
        self.assertEqual(os.stat(self.dest).st_mode & 0o777, 0o700)

    def test_running_it_again_changes_nothing(self):
        data_dir.apply(self.dest)
        again = data_dir.apply(self.dest)
        self.assertEqual(again['moved_entries'], 0)
        self.assertEqual((self.target / 'agents' / 'dev' / 'home' / 'notes.md').read_text(), 'kept')

    def test_puts_the_data_back_when_the_mount_fails(self):
        self.fail_enable = True
        with self.assertRaises(data_dir.Refused) as caught:
            data_dir.apply(self.dest)
        self.assertEqual(caught.exception.code, 'MOUNT_FAILED')
        self.assertEqual((self.target / 'agents' / 'dev' / 'home' / 'notes.md').read_text(), 'kept')
        self.assertFalse(self.unit.exists())
        self.assertFalse(self.dropin.exists())

    def test_refuses_a_second_directory_and_a_full_destination(self):
        data_dir.apply(self.dest)
        with self.assertRaises(data_dir.Refused) as caught:
            data_dir.apply(self.dest.with_name('other'))
        self.assertEqual(caught.exception.code, 'DATA_DIR_IN_USE')

    def test_refuses_when_both_places_hold_data(self):
        self.dest.mkdir(parents=True)
        (self.dest / 'stray').write_text('x')
        with self.assertRaises(data_dir.Refused) as caught:
            data_dir.apply(self.dest)
        self.assertEqual(caught.exception.code, 'DATA_DIR_NOT_EMPTY')
        self.assertTrue((self.target / 'agents' / 'dev' / 'home' / 'notes.md').exists())

    def test_refuses_a_network_filesystem_and_live_cells(self):
        with mock.patch.object(data_dir, 'filesystem', lambda path: 'nfs'):
            with self.assertRaises(data_dir.Refused) as caught:
                data_dir.apply(self.dest)
        self.assertEqual(caught.exception.code, 'BAD_DATA_DIR')
        with mock.patch.object(data_dir, 'live_cells', lambda: [{'task': 't-1'}]):
            with self.assertRaises(data_dir.Refused) as caught:
                data_dir.apply(self.dest)
        self.assertEqual(caught.exception.code, 'CELLS_ALIVE')
        self.assertTrue((self.target / 'agents' / 'dev' / 'home' / 'notes.md').exists())


class MainTest(unittest.TestCase):
    def test_prints_one_json_refusal(self):
        with mock.patch('builtins.print') as printed:
            code = data_dir.main(['anchi_data_dir.py', 'relative', '--home', '/data/home'])
        self.assertEqual(code, 1)
        self.assertEqual(json.loads(printed.call_args[0][0])['error'], 'BAD_DATA_DIR')


if __name__ == '__main__':
    unittest.main()
