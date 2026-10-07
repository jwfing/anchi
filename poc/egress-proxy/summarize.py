"""Summarize proxy log entries since a Unix timestamp. Logs hold no secrets."""

import collections
import json
import os
import sys
from pathlib import Path

since = float(sys.argv[1]) if len(sys.argv) > 1 else 0.0
log = Path(os.environ.get("ANCHI_POC_LOG", Path(__file__).with_name("out") / "flows.jsonl"))
rows = [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []
rows = [r for r in rows if r.get("ts", 0) >= since]
counts = collections.Counter(
    (r.get("host"), r.get("rule"), r.get("decision", r.get("event")), r.get("client_cred", "-"), r.get("op", r.get("path")))
    for r in rows
)
print(f"== proxy saw {len(rows)} entries")
for (host, rule, decision, cred, op), n in sorted(counts.items(), key=lambda kv: str(kv[0])):
    print(f"{n:4}  {decision:<18} client={cred:<11} rule={str(rule):<15} {host}  {op}")
