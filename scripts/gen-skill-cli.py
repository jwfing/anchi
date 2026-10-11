"""Regenerates skills/anchi/references/cli.md from the CLI's own help. Run after changing a command:

python3 scripts/gen-skill-cli.py
"""

import os
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
CLI = [
    'node',
    '--import',
    str(ROOT / 'anchi/node_modules/tsx/dist/loader.mjs'),
    str(ROOT / 'anchi/packages/tui/src/main.ts'),
]
# A fixed home, so paths in the help read `~` whoever runs this.
ENV = {**os.environ, 'HOME': '/home/USER'}


def help_text(args):
    out = subprocess.run([*CLI, *args, '--help'], capture_output=True, text=True, env=ENV, check=True).stdout
    return out.replace('/home/USER', '~')


def subcommands(text):
    if 'Commands:' not in text:
        return []
    names = (re.match(r'^  ([a-z][a-z-]*)', line) for line in text.split('Commands:', 1)[1].splitlines())
    return [m.group(1) for m in names if m and m.group(1) != 'help']


def walk(path, out):
    text = help_text(path)
    if path:
        body = '\n'.join(
            line
            for line in text.splitlines()
            if 'display help for command' not in line and not line.strip().startswith('-h, --help')
        ).strip()
        out += [f'{"#" * min(len(path) + 1, 4)} `anchi {" ".join(path)}`', '', '```text', body, '```', '']
    for name in subcommands(text):
        walk([*path, name], out)
    return out


lines = [
    '# `anchi` command reference',
    '',
    'Generated from `anchi --help` by `scripts/gen-skill-cli.py`; run `anchi <command> --help` for the installed '
    'version. From a source checkout, use `scripts/anchi`.',
    '',
]
(ROOT / 'skills/anchi/references/cli.md').write_text('\n'.join(walk([], lines)).rstrip() + '\n')
