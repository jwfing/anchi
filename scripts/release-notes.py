"""Render one tagged version of CHANGELOG.md for GitHub Releases; never publish Unreleased."""

import argparse
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
VERSION = r'(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)'


def release_notes(changelog: str, tag: str, package_version: str) -> str:
    if not re.fullmatch(rf'v{VERSION}', tag) or tag != f'v{package_version}':
        raise ValueError('release tag must be v<package version>, without a prerelease suffix')
    headings = list(re.finditer(r'^## (.+)$', changelog, re.MULTILINE))
    matches = [
        (i, h)
        for i, h in enumerate(headings)
        if re.fullmatch(rf'{re.escape(package_version)} — \d{{4}}-\d{{2}}-\d{{2}}', h[1])
    ]
    if len(matches) != 1:
        raise ValueError('expected exactly one dated changelog section for this version')
    i, heading = matches[0]
    end = headings[i + 1].start() if i + 1 < len(headings) else len(changelog)
    body = changelog[heading.end() : end].strip()
    if not body or not any(line.strip() and not line.startswith('#') for line in body.splitlines()):
        raise ValueError('the release changelog section is empty')
    return f'''{body}

---

## Install and upgrade

Development preview for Apple Silicon macOS and glibc Linux x86_64 (experimental).
The app includes Node and its dependencies. VM prerequisites and setup:
[Getting started](https://github.com/jwfing/anchi/blob/{tag}/docs/GETTING_STARTED.md).

```sh
curl -fsSL https://anchi.elseward.xyz/install.sh | ANCHI_VERSION={tag} sh -s -- --desktop
```

Open `~/Applications/Anchi.app` on macOS, or **Anchi** from the applications menu on Linux
(`anchi-desktop`). For a terminal-only installation, omit `-s -- --desktop` and run `anchi`.

Existing installations: `anchi update`. Follow any VM migration or `anchi setup install`
steps listed above; updating the app alone does not update the VM's components.

Archives have SHA-256 checksums, not publisher signatures. Anchi has not completed a security
audit. Read the [security model](https://github.com/jwfing/anchi/blob/{tag}/SECURITY.md) before
connecting accounts. [Full changelog](https://github.com/jwfing/anchi/blob/{tag}/CHANGELOG.md).
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('tag')
    args = parser.parse_args()
    try:
        print(
            release_notes(
                (ROOT / 'CHANGELOG.md').read_text(),
                args.tag,
                json.loads((ROOT / 'anchi/package.json').read_text())['version'],
            ),
            end='',
        )
    except ValueError as error:
        parser.error(str(error))


if __name__ == '__main__':
    main()
