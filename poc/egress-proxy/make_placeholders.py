"""Write placeholder client credential files. Contains no real secrets."""

import base64
import datetime as dt
import json
import sys
import time
from pathlib import Path


def fake_jwt(claims: dict) -> str:
    def enc(obj):
        return base64.urlsafe_b64encode(json.dumps(obj).encode()).rstrip(b"=").decode()

    return f"{enc({'alg': 'none', 'typ': 'JWT'})}.{enc(claims)}.anchi-placeholder"


def codex(home: Path) -> None:
    home.mkdir(parents=True, exist_ok=True)
    exp = int(time.time()) + 30 * 86400
    auth_claims = {"chatgpt_plan_type": "plus", "chatgpt_account_id": "anchi-placeholder"}
    tokens = {
        "id_token": fake_jwt({"email": "anchi-placeholder@example.invalid", "exp": exp,
                              "https://api.openai.com/auth": auth_claims}),
        "access_token": fake_jwt({"exp": exp, "https://api.openai.com/auth": auth_claims}),
        "refresh_token": "anchi-placeholder",
        "account_id": "anchi-placeholder",
    }
    now = dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")
    (home / "auth.json").write_text(json.dumps({"OPENAI_API_KEY": None, "tokens": tokens, "last_refresh": now}))
    (home / "config.toml").write_text('cli_auth_credentials_store = "file"\n')


if __name__ == "__main__":
    {"codex": codex}[sys.argv[1]](Path(sys.argv[2]))
