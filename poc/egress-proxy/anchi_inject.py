"""PoC mitmproxy addon: inject or re-sign upstream credentials for cell traffic.

Real credentials are read only from environment variables of the proxy
process. Clients hold placeholders. Logs record method/host/path, the matched
rule, the decision and what kind of credential the client sent -- never
header values.

Run:  mitmdump -s anchi_inject.py --listen-port 18080
"""

import json
import os
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import parse_qs

PLACEHOLDER_MARK = "anchi-placeholder"
PLACEHOLDER_AWS_KEY = "AKIAANCHIPLACEHOLDER"
LOG_PATH = Path(os.environ.get("ANCHI_POC_LOG", Path(__file__).with_name("out") / "flows.jsonl"))


@dataclass(frozen=True)
class Rule:
    name: str
    hosts: tuple[str, ...]
    kind: str  # bearer | basic | aws_sigv4
    env: tuple[str, ...]
    deny: tuple[str, ...] = field(default=())  # regexes over the operation string
    extra_headers: tuple[tuple[str, str], ...] = field(default=())  # (header, env var)


RULES: tuple[Rule, ...] = (
    Rule(
        name="anthropic",
        hosts=("api.anthropic.com",),
        kind="bearer",
        env=("ANCHI_POC_CLAUDE_TOKEN",),
    ),
    Rule(
        name="openai-chatgpt",
        hosts=("chatgpt.com",),
        kind="bearer",
        env=("ANCHI_POC_CODEX_ACCESS_TOKEN",),
        extra_headers=(("chatgpt-account-id", "ANCHI_POC_CODEX_ACCOUNT_ID"),),
    ),
    Rule(
        # Token refresh must never run in the cell: a refresh would return a new
        # credential in the response body. Deny and record the attempt.
        name="openai-auth",
        hosts=("auth.openai.com",),
        kind="bearer",
        env=(),
        deny=(r".*",),
    ),
    Rule(
        name="github-api",
        hosts=("api.github.com",),
        kind="bearer",
        env=("ANCHI_POC_GITHUB_TOKEN",),
        deny=(
            r"^POST /user/keys$",
            r"^POST /repos/[^/]+/[^/]+/keys$",
            r"^POST /app/installations/[^/]+/access_tokens$",
            r"^(GET|PUT|DELETE) /repos/[^/]+/[^/]+/actions/secrets",
            r"^(GET|PUT|DELETE) /orgs/[^/]+/actions/secrets",
        ),
    ),
    Rule(
        name="github-git",
        hosts=("github.com",),
        kind="basic",
        env=("ANCHI_POC_GITHUB_TOKEN",),
    ),
    Rule(
        name="aws",
        hosts=("*.amazonaws.com",),
        kind="aws_sigv4",
        env=("ANCHI_POC_AWS_ACCESS_KEY_ID", "ANCHI_POC_AWS_SECRET_ACCESS_KEY"),
        deny=(
            r"^iam:(?!Get|List).*",
            r"^sts:(?!GetCallerIdentity$).*",
        ),
    ),
)


def host_matches(pattern: str, host: str) -> bool:
    host = host.lower().rstrip(".")
    if pattern.startswith("*."):
        return host.endswith(pattern[1:])
    return host == pattern


def find_rule(host: str) -> Rule | None:
    for rule in RULES:
        if any(host_matches(p, host) for p in rule.hosts):
            return rule
    return None


def classify_credential(headers) -> str:
    """Describe what the client sent without revealing it."""
    auth = headers.get("authorization", "")
    if not auth:
        return "none"
    if PLACEHOLDER_MARK in auth or PLACEHOLDER_AWS_KEY in auth:
        return "placeholder"
    if auth.lower().startswith("basic "):
        import base64

        try:
            if PLACEHOLDER_MARK in base64.b64decode(auth[6:]).decode("utf-8", "replace"):
                return "placeholder"
        except ValueError:
            pass
    return "other"


AWS_SCOPE = re.compile(r"Credential=[^/]+/\d{8}/([^/]+)/([^/]+)/aws4_request")


def aws_scope(headers) -> tuple[str, str] | None:
    match = AWS_SCOPE.search(headers.get("authorization", ""))
    return (match.group(1), match.group(2)) if match else None


def aws_operation(service: str, headers, body: bytes, method: str, path: str) -> str:
    target = headers.get("x-amz-target")
    if target:
        return f"{service}:{target.rsplit('.', 1)[-1]}"
    ctype = headers.get("content-type", "")
    if "x-www-form-urlencoded" in ctype:
        action = parse_qs(body.decode("utf-8", "replace")).get("Action")
        if action:
            return f"{service}:{action[0]}"
    if "?" in path:
        action = parse_qs(path.split("?", 1)[1]).get("Action")
        if action:
            return f"{service}:{action[0]}"
    return f"{service}:{method} {path.split('?', 1)[0]}"


def operation(rule: Rule, method: str, path: str, headers, body: bytes) -> str:
    if rule.kind == "aws_sigv4":
        scope = aws_scope(headers)
        service = scope[1] if scope else "unknown"
        return aws_operation(service, headers, body, method, path)
    return f"{method} {path.split('?', 1)[0]}"


def denied(rule: Rule, op: str) -> bool:
    return any(re.search(p, op) for p in rule.deny)


# Headers that the client signed with the placeholder and that must be
# recomputed, plus proxy/hop-by-hop headers that must not be signed.
AWS_STRIP = {"authorization", "x-amz-date", "x-amz-security-token", "proxy-connection", "connection"}


def aws_resign(method: str, url: str, headers: dict[str, str], body: bytes, region: str, service: str, env) -> dict[str, str]:
    """Return a new header set signed with the real credentials."""
    from botocore.auth import SigV4Auth
    from botocore.awsrequest import AWSRequest
    from botocore.credentials import Credentials

    creds = Credentials(
        env["ANCHI_POC_AWS_ACCESS_KEY_ID"],
        env["ANCHI_POC_AWS_SECRET_ACCESS_KEY"],
        env.get("ANCHI_POC_AWS_SESSION_TOKEN") or None,
    )
    kept = {k: v for k, v in headers.items() if k.lower() not in AWS_STRIP}
    if kept.get("x-amz-content-sha256", "").startswith("STREAMING-"):
        raise ValueError("aws-chunked streaming payloads are not re-signed")
    request = AWSRequest(method=method, url=url, data=body, headers=kept)
    SigV4Auth(creds, service, region).add_auth(request)
    return dict(request.headers.items())


def inject(rule: Rule, headers: dict[str, str], env) -> dict[str, str]:
    """Return headers with the real credential for bearer/basic rules."""
    import base64

    out = {k: v for k, v in headers.items() if k.lower() != "authorization"}
    secret = env[rule.env[0]]
    if rule.kind == "bearer":
        out["authorization"] = f"Bearer {secret}"
    elif rule.kind == "basic":
        out["authorization"] = "Basic " + base64.b64encode(f"x-access-token:{secret}".encode()).decode()
    for header, var in rule.extra_headers:
        if env.get(var):
            out = {k: v for k, v in out.items() if k.lower() != header}
            out[header] = env[var]
    return out


def log(entry: dict) -> None:
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    entry["ts"] = round(time.time(), 3)
    with LOG_PATH.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(entry, sort_keys=True) + "\n")


class AnchiInject:
    def request(self, flow) -> None:
        from mitmproxy import http

        req = flow.request
        host = req.pretty_host
        rule = find_rule(host)
        body = req.get_content(strict=False) or b""
        entry = {
            "method": req.method,
            "host": host,
            "path": req.path.split("?", 1)[0],
            "client_cred": classify_credential(req.headers),
            "rule": rule.name if rule else None,
        }
        if rule is None:
            entry["decision"] = "passthrough"
            log(entry)
            return
        op = operation(rule, req.method, req.path, req.headers, body)
        entry["op"] = op
        if denied(rule, op):
            entry["decision"] = "denied"
            log(entry)
            flow.response = http.Response.make(403, f"anchi: {op} denied\n".encode(), {"content-type": "text/plain"})
            return
        missing = [v for v in rule.env if not os.environ.get(v)]
        if missing:
            entry["decision"] = "missing-credential"
            log(entry)
            flow.response = http.Response.make(502, f"anchi: proxy lacks {', '.join(missing)}\n".encode(), {"content-type": "text/plain"})
            return
        current = {k: v for k, v in req.headers.items()}
        try:
            if rule.kind == "aws_sigv4":
                scope = aws_scope(req.headers)
                if scope is None:
                    raise ValueError("request is not SigV4-signed")
                new = aws_resign(req.method, req.url, current, body, scope[0], scope[1], os.environ)
            else:
                new = inject(rule, current, os.environ)
        except ValueError as exc:
            entry["decision"] = "rejected"
            entry["reason"] = str(exc)
            log(entry)
            flow.response = http.Response.make(403, f"anchi: {exc}\n".encode(), {"content-type": "text/plain"})
            return
        req.headers.clear()
        for k, v in new.items():
            req.headers[k] = v
        entry["decision"] = "injected"
        log(entry)

    def response(self, flow) -> None:
        # Record redirects so the PoC shows whether clients follow them off-host.
        if flow.response and 300 <= flow.response.status_code < 400:
            log({"event": "redirect", "host": flow.request.pretty_host, "status": flow.response.status_code})


addons = [AnchiInject()]
