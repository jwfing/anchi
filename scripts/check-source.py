"""Offline syntax checks. Does not import services or contact the VM."""

import ast
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]

for directory in ("services", "scripts", "guest", "tests"):
    for source in sorted((ROOT / directory).glob("*.py")):
        ast.parse(source.read_text(), filename=str(source))
    for source in sorted((ROOT / directory).glob("*.sh")):
        subprocess.run(["bash", "-n", str(source)], check=True)

subprocess.run(["bash", "-n", str(ROOT / "guest/cell-run")], check=True)
print("Python and shell syntax checks passed.")
