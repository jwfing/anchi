"""Regenerates skills/anchi/references/cli.md from the CLI's own help. Run after changing a command:

python3 scripts/gen-skill-cli.py           # rewrite the file
python3 scripts/gen-skill-cli.py --check   # fail if it is out of date (make check)
"""

import json
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'skills/anchi/references/cli.md'
CLI = [
    'node',
    '--import',
    str(ROOT / 'anchi/node_modules/tsx/dist/loader.mjs'),
    str(ROOT / 'anchi/packages/tui/src/main.ts'),
]
# Help text mentions paths under the home directory: render them as `~/.anchi` for everyone.
ENV = {k: v for k, v in os.environ.items() if k != 'ANCHI_HOME'} | {'HOME': '/home/USER'}


def help_tree():
    """Every command's help as `--help` prints it, from the CLI's hidden `help-tree` command."""
    result = subprocess.run([*CLI, 'help-tree'], capture_output=True, text=True, env=ENV)
    if result.returncode:
        sys.exit(f'anchi help-tree failed:\n{result.stderr}')
    return json.loads(result.stdout.replace('/home/USER', '~'))


def section(help_text):
    """The help without commander's own help entries, and without an `Options:` heading left empty."""
    lines = [
        line
        for line in help_text.rstrip().splitlines()
        if not line.strip().startswith('-h, --help') and 'display help for command' not in line
    ]
    out = []
    for i, line in enumerate(lines):
        if line == 'Options:' and (i + 1 == len(lines) or not lines[i + 1].startswith('  ')):
            if out and out[-1] == '':
                out.pop()
            continue
        out.append(line)
    return '\n'.join(out).strip()


def render():
    lines = [
        '# `anchi` command reference',
        '',
        'Generated from `anchi --help` by `scripts/gen-skill-cli.py`; run `anchi <command> --help` for the '
        'installed version. From a source checkout, use `scripts/anchi`.',
        '',
    ]
    for entry in help_tree():
        if not entry['path']:
            continue
        depth = len(entry['path'])
        lines += [f'{"#" * min(depth + 1, 4)} `anchi {" ".join(entry["path"])}`', '', '```text']
        lines += [section(entry['help']), '```', '']
    return '\n'.join(lines).rstrip() + '\n'


text = render()
if '--check' in sys.argv[1:]:
    if OUT.read_text() != text:
        sys.exit(f'{OUT.relative_to(ROOT)} is out of date: run python3 scripts/gen-skill-cli.py')
    print('skills/anchi/references/cli.md is current.')
else:
    OUT.write_text(text)
