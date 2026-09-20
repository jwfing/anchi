#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
limactl shell secure-vm -- sudo /usr/local/sbin/secure-cell-run /usr/bin/python3 /opt/secure-vm/check-cell.py
limactl shell secure-vm -- sudo /usr/local/sbin/secure-cell-run /usr/bin/python3 /opt/secure-vm/check-gmail.py
limactl shell secure-vm -- sudo /usr/local/sbin/secure-cell-run /usr/bin/python3 /opt/secure-vm/check-inference.py

limactl shell secure-vm -- sudo /usr/bin/python3 /opt/secure-vm/check-security.py
