"""Release notes must carry upgrade instructions for exactly the published version."""

import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('release_notes', ROOT / 'scripts/release-notes.py')
NOTES = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(NOTES)

CHANGELOG = '''# Changelog

## Unreleased

- Not shipped.

## 1.2.3 — 2026-10-11

After updating, run `anchi setup install`.

### Fixed

- A release-specific fix.

## 1.2.2 — 2026-10-10

- An older fix.
'''


class ReleaseNotesTest(unittest.TestCase):
    def test_preserves_changes_and_required_migration_without_other_versions(self):
        notes = NOTES.release_notes(CHANGELOG, 'v1.2.3', '1.2.3')
        self.assertIn('After updating, run `anchi setup install`.', notes)
        self.assertIn('A release-specific fix.', notes)
        self.assertIn('ANCHI_VERSION=v1.2.3', notes)
        self.assertIn('/blob/v1.2.3/SECURITY.md', notes)
        self.assertNotIn('Not shipped.', notes)
        self.assertNotIn('An older fix.', notes)

    def test_refuses_missing_duplicate_empty_or_mismatched_sections(self):
        for changelog, tag, version in [
            (CHANGELOG, 'v1.2.4', '1.2.3'),
            (CHANGELOG, 'v1.2.4', '1.2.4'),
            (CHANGELOG, 'Unreleased', '1.2.3'),
            (CHANGELOG, 'v1.2.3-rc.1', '1.2.3-rc.1'),
            (CHANGELOG + '\n## 1.2.3 — 2026-10-11\nDuplicate', 'v1.2.3', '1.2.3'),
            ('## 1.2.3 — 2026-10-11\n\n### Added\n', 'v1.2.3', '1.2.3'),
        ]:
            with self.subTest(tag=tag, changelog=changelog):
                with self.assertRaises(ValueError):
                    NOTES.release_notes(changelog, tag, version)
