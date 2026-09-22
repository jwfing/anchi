import importlib.util
import json
from unittest.mock import patch
import os
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location(
    'host_files', Path(__file__).resolve().parents[1] / 'scripts/host-files.py'
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class HostFilesTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        st = self.root.stat()
        self.grant = {'path': str(self.root), 'mode': 'rw', 'identity': [str(st.st_dev), str(st.st_ino)]}

    def run_op(self, op, path='', **extra):
        return module.operate({'grant': self.grant, 'request': {'op': op, 'path': path, **extra}})

    def test_lifecycle_keeps_previous_versions_recoverable(self):
        self.run_op('mkdir', 'output')
        self.assertEqual(self.run_op('write', 'output/report.txt', text='你好'), {'written': True})
        self.assertEqual(self.run_op('read', 'output/report.txt'), {'text': '你好'})
        self.assertEqual(self.run_op('list')['entries'], [{'name': 'output', 'kind': 'directory'}])
        replaced = self.run_op('write', 'output/report.txt', text='replacement')
        self.assertEqual((self.root / replaced['previous']).read_text(), '你好')
        deleted = self.run_op('delete', 'output/report.txt')
        self.assertFalse((self.root / 'output/report.txt').exists())
        self.assertEqual((self.root / deleted['trashed_as']).read_text(), 'replacement')
        self.assertTrue(deleted['trashed_as'].startswith(module.TRASH + '/'))
        self.assertEqual(
            json.loads((self.root / (deleted['trashed_as'] + '.json')).read_text())['original_path'],
            'output/report.txt',
        )
        # The trash stays hidden from listing and unreachable through the tool.
        self.assertEqual(self.run_op('list')['entries'], [{'name': 'output', 'kind': 'directory'}])
        with self.assertRaisesRegex(ValueError, 'INVALID_PATH'):
            self.run_op('list', module.TRASH)
        with self.assertRaisesRegex(ValueError, 'INVALID_PATH'):
            self.run_op('read', deleted['trashed_as'])

    def test_read_only_blocks_mutations(self):
        self.grant['mode'] = 'ro'
        for op in ('write', 'mkdir', 'delete'):
            with self.assertRaisesRegex(ValueError, 'READ_ONLY'):
                self.run_op(op, 'x', text='x')

    def test_escape_links_hidden_and_special_files(self):
        (self.root / 'link').symlink_to('/etc')
        (self.root / 'file').write_text('x')
        os.link(self.root / 'file', self.root / 'hard')
        os.mkfifo(self.root / 'pipe')
        for target in ('../escape', '/etc/passwd', 'link/passwd', '.env', 'hard', 'pipe'):
            with self.assertRaises((ValueError, OSError)):
                self.run_op('read', target)

    def test_identity_and_limits(self):
        with self.assertRaisesRegex(ValueError, 'FILE_TOO_LARGE'):
            self.run_op('write', 'big', text='x' * 24001)
        self.grant['identity'][1] = '0'
        with self.assertRaisesRegex(ValueError, 'DIRECTORY_CHANGED'):
            self.run_op('list')

    def test_failed_replace_keeps_original_and_backup(self):
        self.run_op('write', 'report.txt', text='old')
        with patch.object(module.os, 'replace', side_effect=OSError('injected')):
            with self.assertRaises(OSError):
                self.run_op('write', 'report.txt', text='new')
        self.assertEqual(self.run_op('read', 'report.txt')['text'], 'old')
        backups = [p for p in (self.root / module.TRASH).iterdir() if not p.name.endswith('.json')]
        self.assertEqual([p.read_text() for p in backups], ['old'])
        self.assertFalse(any(p.name.startswith('.anchi-') and p.is_file() for p in self.root.iterdir()))

    def test_long_nested_paths_and_unicode_names_are_recoverable(self):
        for name in ('x' * 230, '中文' * 35):
            relative = 'nested/' + name
            (self.root / 'nested').mkdir(exist_ok=True)
            self.run_op('write', relative, text='old')
            result = self.run_op('write', relative, text='new')
            self.assertEqual((self.root / result['previous']).read_text(), 'old')
            result = self.run_op('delete', relative)
            self.assertEqual((self.root / result['trashed_as']).read_text(), 'new')
            self.assertEqual(
                json.loads((self.root / (result['trashed_as'] + '.json')).read_text())['original_path'], relative
            )

    def test_large_previous_file_is_not_destroyed_by_overwrite(self):
        (self.root / 'large').write_bytes(b'x' * (module.LIMIT + 1))
        with self.assertRaisesRegex(ValueError, 'UNSAFE_OR_LARGE_FILE'):
            self.run_op('write', 'large', text='new')
        self.assertEqual((self.root / 'large').stat().st_size, module.LIMIT + 1)
