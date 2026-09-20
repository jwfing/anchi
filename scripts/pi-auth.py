"""Copy only an existing Codex subscription access token into the encrypted VM vault."""
import argparse
import json
from pathlib import Path
import resource
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument('--auth-file', type=Path, default=Path.home()/'.codex/auth.json')
parser.add_argument('--model', default=None)
args = parser.parse_args()
if args.model is None:
    try:
        import tomllib
        args.model = tomllib.loads((Path.home()/'.codex/config.toml').read_text()).get('model') or 'gpt-6-astra'
    except (OSError, ValueError):
        args.model = 'gpt-6-astra'
resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
try:
    source = json.loads(args.auth_file.read_text())
    if source.get('auth_mode') != 'chatgpt':
        raise ValueError()
    tokens = source['tokens']
    value = {'access_token':tokens['access_token'], 'account_id':tokens['account_id'], 'model':args.model}
except Exception:
    raise SystemExit('A valid ChatGPT-mode Codex auth cache is required. Run codex login on the host; do not paste tokens into chat.') from None
run = subprocess.run(['limactl','shell','secure-vm','--','sudo','python3',
    '/opt/secure-vm/services/codex_admin.py','import'], input=json.dumps(value), text=True, capture_output=True)
try:
    result = json.loads(run.stdout)
except ValueError:
    raise SystemExit('Cannot contact credential admin; secret-bearing output suppressed.') from None
print(json.dumps(result, indent=2))
raise SystemExit(run.returncode)
