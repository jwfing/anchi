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
for source in sorted((ROOT / "pi").glob("*.mjs")):
    subprocess.run(["node", "--check", str(source)], check=True)
print("Python, shell and Pi syntax checks passed.")
