"""Release images cross into guest root: refuse corrupt archives and escaping paths."""

import hashlib
import importlib.util
import io
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('anchi_prebuilt', Path(__file__).parents[1] / 'guest/anchi_prebuilt.py')
prebuilt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prebuilt)


class ArchiveTests(unittest.TestCase):
    def archive(self, root, members):
        path = root / 'image.tar.gz'
        with tarfile.open(path, 'w:gz') as out:
            for name, kind, value in members:
                entry = tarfile.TarInfo(name)
                entry.type = kind
                entry.mode = 0o755
                if kind == tarfile.REGTYPE:
                    entry.size = len(value)
                    out.addfile(entry, io.BytesIO(value))
                else:
                    entry.linkname = value
                    out.addfile(entry)
        return path

    def test_refuses_traversal_symlink_ancestors_devices_and_duplicate_files(self):
        for members in (
            [('../outside', tarfile.REGTYPE, b'bad')],
            [('/outside', tarfile.REGTYPE, b'bad')],
            [('a', tarfile.SYMTYPE, '/tmp'), ('a/outside', tarfile.REGTYPE, b'bad')],
            [('a/outside', tarfile.REGTYPE, b'bad'), ('a', tarfile.SYMTYPE, '/tmp')],
            [('a', tarfile.LNKTYPE, '../outside')],
            [('a', tarfile.FIFOTYPE, '')],
            [('a', tarfile.REGTYPE, b'first'), ('a', tarfile.REGTYPE, b'second')],
        ):
            with self.subTest(members=members), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                archive = self.archive(root, members)
                target = root / 'stage'
                target.mkdir()
                with self.assertRaisesRegex(ValueError, 'PREBUILT_'):
                    prebuilt.extract(archive, target, 0, 65536, ownership=False)
                self.assertEqual(list(target.iterdir()), [])

    def test_refuses_checksum_mismatch_before_opening_archive(self):
        with tempfile.TemporaryDirectory() as tmp:
            archive = Path(tmp) / 'archive'
            archive.write_bytes(b'corrupt')
            with self.assertRaisesRegex(ValueError, 'PREBUILT_CHECKSUM'):
                prebuilt.verify(archive, {'sha256': '0' * 64, 'bytes': 7})

    def test_extracts_internal_links_without_following_them(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            archive = self.archive(
                root,
                [
                    ('usr', tarfile.DIRTYPE, ''),
                    ('usr/tool', tarfile.REGTYPE, b'hello'),
                    ('bin', tarfile.SYMTYPE, '/usr'),
                    ('usr/copy', tarfile.LNKTYPE, 'usr/tool'),
                ],
            )
            prebuilt.verify(
                archive, {'sha256': hashlib.sha256(archive.read_bytes()).hexdigest(), 'bytes': archive.stat().st_size}
            )
            target = root / 'stage'
            target.mkdir()
            prebuilt.extract(archive, target, 0, 65536, ownership=False)
            self.assertEqual((target / 'usr/copy').read_bytes(), b'hello')
            self.assertEqual((target / 'bin').readlink(), Path('/usr'))

    def test_bounds_archive_contents_and_rejects_unmapped_owners_and_xattrs(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            target = root / 'stage'
            target.mkdir()
            archive = self.archive(root, [('file', tarfile.REGTYPE, b'too large')])
            with patch.object(prebuilt, 'MAX_CONTENT', 2), self.assertRaisesRegex(ValueError, 'PREBUILT_TOO_LARGE'):
                prebuilt.extract(archive, target, 0, 65536, ownership=False)
            for uid, pax in [(65536, {}), (0, {'SCHILY.xattr.security.capability': 'bad'})]:
                with tarfile.open(archive, 'w:gz') as out:
                    entry = tarfile.TarInfo('file')
                    entry.uid = uid
                    entry.pax_headers = pax
                    out.addfile(entry, io.BytesIO(b''))
                with self.assertRaisesRegex(ValueError, 'PREBUILT_BAD_'):
                    prebuilt.extract(archive, target, 0, 65536, ownership=False)
            self.assertEqual(list(target.iterdir()), [])

    def test_repeated_root_directory_entries_are_counted(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            archive = self.archive(root, [('.', tarfile.DIRTYPE, ''), ('.', tarfile.DIRTYPE, '')])
            with patch.object(prebuilt, 'MAX_MEMBERS', 1), self.assertRaisesRegex(ValueError, 'PREBUILT_TOO_LARGE'):
                prebuilt.extract(archive, root / 'target', 0, 65536, ownership=False)

    def test_source_and_installed_recipe_layouts_have_the_same_identity(self):
        import shutil

        source = Path(__file__).parents[1] / 'guest'
        with tempfile.TemporaryDirectory() as tmp:
            lib = Path(tmp)
            for name in ('bootstrap.sh', 'install-anchi.sh'):
                shutil.copyfile(source / name, lib / name)
            for name in (
                'build-base.sh',
                'build-runtime-codex.sh',
                'build-runtime-claude-code.sh',
                'build-runtime-hermes.sh',
            ):
                shutil.copyfile(source / f'anchi-{name}', lib / name)
            self.assertEqual(
                prebuilt.compatibility(source, source / 'cell.env'), prebuilt.compatibility(lib, source / 'cell.env')
            )

    def test_manifest_binds_architecture_recipes_and_exact_release_asset(self):
        layers = {
            image: {'file': f'anchi-layer-aarch64-{image}.tar.gz', 'sha256': 'a' * 64, 'bytes': 10}
            for image in ('codex', 'runtime-codex', 'runtime-claude-code', 'runtime-hermes')
        }
        manifest = {'schema': 1, 'version': '1.2.3', 'arch': 'aarch64', 'compatibility': 'b' * 64, 'layers': layers}
        self.assertEqual(prebuilt.entry_for(manifest, 'codex', 'b' * 64, 'aarch64'), layers['codex'])
        for identity, arch in [('c' * 64, 'aarch64'), ('b' * 64, 'x86_64')]:
            with self.assertRaisesRegex(ValueError, 'PREBUILT_INCOMPATIBLE'):
                prebuilt.entry_for(manifest, 'codex', identity, arch)
        layers['codex']['file'] = '../../other.tar.gz'
        with self.assertRaisesRegex(ValueError, 'PREBUILT_BAD_MANIFEST'):
            prebuilt.entry_for(manifest, 'codex', 'b' * 64, 'aarch64')

    def test_corrupt_download_keeps_the_previous_layer(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            lib = root / 'lib'
            lib.mkdir()
            (lib / 'prebuilt.json').write_text('{"version":"1.2.3"}')
            env = root / 'cell.env'
            env.write_text('SECURE_CELL_UID_BASE=100000\nSECURE_CELL_UID_COUNT=65536\n')
            target = root / 'layers/base'
            target.mkdir(parents=True)
            (target / 'keep').write_text('previous')
            entry = {'file': 'archive.tar.gz', 'bytes': 7, 'sha256': '0' * 64}
            with (
                patch.object(prebuilt, 'compatibility', return_value='test'),
                patch.object(prebuilt, 'entry_for', return_value=entry),
                patch.object(prebuilt.urllib.request, 'urlopen', return_value=io.BytesIO(b'corrupt')),
            ):
                with self.assertRaisesRegex(ValueError, 'PREBUILT_CHECKSUM'):
                    prebuilt.install('codex', 'base', target, 'base-test', lib, env)
            self.assertEqual((target / 'keep').read_text(), 'previous')
            self.assertEqual(list(target.parent.iterdir()), [target])


if __name__ == '__main__':
    unittest.main()
