"""Offline checks for the PoC addon using fake credentials only."""

import base64
import datetime as dt
import json

import pytest
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest
from botocore.credentials import Credentials
from mitmproxy.test import tflow, tutils

import anchi_inject as ai

REAL_BLOCKED_DESTINATION = ai.blocked_destination

FAKE_ENV = {
    "ANCHI_POC_CLAUDE_TOKEN": "fake-claude",
    "ANCHI_POC_CODEX_ACCESS_TOKEN": "fake-codex",
    "ANCHI_POC_CODEX_ACCOUNT_ID": "fake-account",
    "ANCHI_POC_GITHUB_TOKEN": "fake-gh",
    "ANCHI_POC_AWS_ACCESS_KEY_ID": "AKIAFAKEREAL0000000",
    "ANCHI_POC_AWS_SECRET_ACCESS_KEY": "fake-secret",
}


@pytest.fixture(autouse=True)
def env(monkeypatch, tmp_path):
    for k, v in FAKE_ENV.items():
        monkeypatch.setenv(k, v)
    monkeypatch.setattr(ai, "LOG_PATH", tmp_path / "flows.jsonl")
    # Keep tests offline; destination filtering has its own tests below.
    monkeypatch.setattr(ai, "blocked_destination", lambda host: None)
    return tmp_path / "flows.jsonl"


def flow(method, host, path, headers=(), content=b""):
    req = tutils.treq(method=method.encode(), host=host, port=443, scheme=b"https", path=path.encode(),
                      headers=[(k.encode(), v.encode()) for k, v in headers], content=content)
    return tflow.tflow(req=req)


def logs(path):
    return [json.loads(line) for line in path.read_text().splitlines()]


def test_bearer_replaces_placeholder(env):
    f = flow("POST", "api.anthropic.com", "/v1/messages", [("authorization", "Bearer sk-ant-oat01-anchi-placeholder")])
    ai.AnchiInject().request(f)
    assert f.request.headers["authorization"] == "Bearer fake-claude"
    (entry,) = logs(env)
    assert entry["decision"] == "injected" and entry["client_cred"] == "placeholder"
    assert "fake-claude" not in env.read_text()


def test_codex_account_header_replaced():
    f = flow("POST", "chatgpt.com", "/backend-api/codex/responses",
             [("authorization", "Bearer anchi-placeholder"), ("chatgpt-account-id", "placeholder")])
    ai.AnchiInject().request(f)
    assert f.request.headers["chatgpt-account-id"] == "fake-account"


def test_openai_refresh_denied(env):
    f = flow("POST", "auth.openai.com", "/oauth/token")
    ai.AnchiInject().request(f)
    assert f.response.status_code == 403
    assert logs(env)[0]["decision"] == "denied"


def test_git_basic_auth():
    f = flow("GET", "github.com", "/jwfing/secure-vm.git/info/refs?service=git-upload-pack")
    ai.AnchiInject().request(f)
    assert base64.b64decode(f.request.headers["authorization"][6:]) == b"x-access-token:fake-gh"


@pytest.mark.parametrize("method,path", [("POST", "/user/keys"), ("PUT", "/repos/a/b/actions/secrets/X")])
def test_github_minting_denied(method, path):
    f = flow(method, "api.github.com", path)
    ai.AnchiInject().request(f)
    assert f.response.status_code == 403


def test_unmatched_host_passthrough(env):
    f = flow("GET", "example.com", "/", [("authorization", "Bearer mine")])
    ai.AnchiInject().request(f)
    assert f.response is None and f.request.headers["authorization"] == "Bearer mine"
    assert logs(env)[0]["client_cred"] == "other"


def test_redirect_never_carries_injection():
    # Injection is keyed on the destination host, so a client-followed redirect
    # to another host is a new request that gets no credential.
    assert ai.find_rule("evil.example") is None
    assert ai.find_rule("api.github.com.evil.example") is None
    assert ai.find_rule("notamazonaws.com") is None


def signed_with(key, secret, method, url, headers, body, region, service):
    req = AWSRequest(method=method, url=url, data=body, headers=headers)
    SigV4Auth(Credentials(key, secret), service, region).add_auth(req)
    return dict(req.headers.items())


def test_aws_resign_produces_valid_signature(monkeypatch):
    body = b"Action=GetCallerIdentity&Version=2011-06-15"
    base = {"content-type": "application/x-www-form-urlencoded; charset=utf-8", "host": "sts.us-east-2.amazonaws.com"}
    client = signed_with(ai.PLACEHOLDER_AWS_KEY, "placeholder", "POST", "https://sts.us-east-2.amazonaws.com/",
                         dict(base), body, "us-east-2", "sts")
    f = flow("POST", "sts.us-east-2.amazonaws.com", "/", list(client.items()), body)
    ai.AnchiInject().request(f)
    out = dict(f.request.headers.items())
    assert "AKIAFAKEREAL0000000/" in out["Authorization"]
    assert ai.PLACEHOLDER_AWS_KEY not in out["Authorization"]
    # Independently recompute with the real key at the proxy's timestamp.
    stamp = dt.datetime.strptime(out["X-Amz-Date"], "%Y%m%dT%H%M%SZ").replace(tzinfo=dt.timezone.utc)
    with monkeypatch.context() as m:
        import botocore.auth

        class Frozen(dt.datetime):
            @classmethod
            def utcnow(cls):
                return stamp.replace(tzinfo=None)

            @classmethod
            def now(cls, tz=None):
                return stamp if tz else stamp.replace(tzinfo=None)

        m.setattr(botocore.auth.datetime, "datetime", Frozen)
        expected = signed_with("AKIAFAKEREAL0000000", "fake-secret", "POST", "https://sts.us-east-2.amazonaws.com/",
                               dict(base), body, "us-east-2", "sts")
    assert out["Authorization"] == expected["Authorization"]


@pytest.mark.parametrize("op_body,target", [
    (b"Action=CreateAccessKey&Version=2010-05-08", None),
    (b"Action=AssumeRole&RoleArn=x&RoleSessionName=y&Version=2011-06-15", None),
    (b"Action=GetSessionToken&Version=2011-06-15", None),
])
def test_aws_minting_denied(op_body, target):
    service = "iam" if b"AccessKey" in op_body else "sts"
    host = "iam.amazonaws.com" if service == "iam" else "sts.us-east-2.amazonaws.com"
    base = {"content-type": "application/x-www-form-urlencoded", "host": host}
    client = signed_with(ai.PLACEHOLDER_AWS_KEY, "p", "POST", f"https://{host}/", dict(base), op_body, "us-east-1", service)
    f = flow("POST", host, "/", list(client.items()), op_body)
    ai.AnchiInject().request(f)
    assert f.response.status_code == 403


def test_aws_json_target_operation():
    headers = {"x-amz-target": "Logs_20140328.FilterLogEvents",
               "authorization": f"AWS4-HMAC-SHA256 Credential={ai.PLACEHOLDER_AWS_KEY}/20261006/us-east-2/logs/aws4_request"}
    rule = ai.find_rule("logs.us-east-2.amazonaws.com")
    assert ai.operation(rule, "POST", "/", headers, b"{}") == "logs:FilterLogEvents"


def test_aws_streaming_rejected():
    client = signed_with(ai.PLACEHOLDER_AWS_KEY, "p", "PUT", "https://b.s3.us-east-2.amazonaws.com/k",
                         {"x-amz-content-sha256": "STREAMING-AWS4-HMAC-SHA256-PAYLOAD"}, b"x", "us-east-2", "s3")
    f = flow("PUT", "b.s3.us-east-2.amazonaws.com", "/k", list(client.items()), b"x")
    ai.AnchiInject().request(f)
    assert f.response.status_code == 403


def test_missing_credential_fails_closed(monkeypatch):
    monkeypatch.delenv("ANCHI_POC_CLAUDE_TOKEN")
    f = flow("POST", "api.anthropic.com", "/v1/messages", [("authorization", "Bearer x")])
    ai.AnchiInject().request(f)
    assert f.response.status_code == 502


@pytest.mark.parametrize("ip", ["127.0.0.1", "10.0.0.5", "192.168.5.2", "169.254.169.254", "100.64.0.1", "::1", "fd00::1"])
def test_private_destinations_refused(ip):
    assert REAL_BLOCKED_DESTINATION(ip) is not None
    assert REAL_BLOCKED_DESTINATION("1.1.1.1") is None


def test_private_destination_gets_403(monkeypatch):
    monkeypatch.setattr(ai, "blocked_destination", lambda host: "non-public destination 127.0.0.1")
    f = flow("GET", "127.0.0.1", "/")
    ai.AnchiInject().request(f)
    assert f.response.status_code == 403


@pytest.mark.parametrize("path,injected", [
    ("/o/r.git/info/refs?service=git-upload-pack", True),
    ("/o/r/git-upload-pack", True),
    ("/o/r.git/git-receive-pack", True),
    ("/openai/codex/releases/download/v1/codex.tar.gz", False),
    ("/login", False),
])
def test_github_git_path_scope(path, injected):
    f = flow("GET", "github.com", path)
    ai.AnchiInject().request(f)
    assert ("authorization" in f.request.headers) is injected
