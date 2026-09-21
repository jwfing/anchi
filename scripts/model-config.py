"""Configure a fixed model from the trusted host, never pass an API key in argv."""

import argparse
import json
from pathlib import Path
import subprocess


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--disable', action='store_true')
    parser.add_argument('--model')
    parser.add_argument('--key-file', type=Path)
    parser.add_argument(
        '--allow-cloud-mail',
        action='store_true',
        help='Explicitly allow sending selected mail text to OpenAI for inference',
    )
    args = parser.parse_args()
    data = None
    if not args.disable:
        if not args.model or not args.key_file or not args.allow_cloud_mail:
            parser.error('Require --model, --key-file and --allow-cloud-mail, or --disable')
        if args.key_file.stat().st_size > 1024:
            parser.error('Key file must contain only the API key, at most 1024 bytes')
        data = {
            'provider': 'openai',
            'model': args.model,
            'api_key': args.key_file.read_text().strip(),
            'allow_cloud_mail': True,
        }
    proc = subprocess.run(
        [
            'limactl',
            'shell',
            'secure-vm',
            '--',
            'sudo',
            '/usr/bin/python3',
            '/opt/secure-vm/services/model_admin.py',
            'disable' if args.disable else 'configure',
        ],
        input='' if data is None else json.dumps(data),
        text=True,
        capture_output=True,
    )
    if proc.returncode:
        raise SystemExit('Model configuration failed; no secrets printed. Check VM and parameters.')
    print(proc.stdout.strip())


if __name__ == '__main__':
    main()
