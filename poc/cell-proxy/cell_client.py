"""Runs inside the cell. Checks proxy reachability and that no other route exists."""

import json
import re
import socket
import ssl
import urllib.error
import urllib.request

PROXY = "http://127.0.0.1:3128"
CA = "/run/anchi-poc/ca.pem"
results = []


def record(name, ok, detail):
    results.append({"check": name, "ok": ok, "detail": detail})


def http(name, url, expect, method="GET", headers=None, data=None):
    ctx = ssl.create_default_context(cafile=CA)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({"https": PROXY}),
                                         urllib.request.HTTPSHandler(context=ctx))
    req = urllib.request.Request(url, method=method, headers=headers or {}, data=data)
    try:
        status = opener.open(req, timeout=15).status
    except urllib.error.HTTPError as exc:
        status = exc.code
    except Exception as exc:  # noqa: BLE001 - report any failure mode
        record(name, False, f"{type(exc).__name__}: {exc}")
        return
    record(name, status == expect, f"status {status}, expected {expect}")


def must_fail(name, fn):
    try:
        fn()
    except OSError as exc:
        record(name, True, f"blocked: {type(exc).__name__}: {exc}")
        return
    record(name, False, "unexpectedly succeeded")


http("passthrough example.com", "https://example.com/", 200)
# Fake token injected by the proxy -> GitHub rejects it with 401. Reaching
# GitHub at all proves the request went through the proxy with TLS interception.
http("inject api.github.com/user", "https://api.github.com/user", 401,
     headers={"Authorization": "Bearer anchi-placeholder"})
http("deny POST /user/keys", "https://api.github.com/user/keys", 403, method="POST", data=b"{}")
must_fail("direct TCP 1.1.1.1:443", lambda: socket.create_connection(("1.1.1.1", 443), timeout=3))
must_fail("DNS lookup", lambda: socket.getaddrinfo("example.com", 443))
must_fail("direct TLS without proxy", lambda: urllib.request.urlopen("https://example.com/", timeout=3))


def via_proxy_must_fail(name, url):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({"http": PROXY, "https": PROXY}))
    try:
        resp = opener.open(url, timeout=5)
        body = resp.read(64)
        record(name, False, f"reached: status {resp.status} {body[:40]!r}")
    except urllib.error.HTTPError as exc:
        body = re.sub(r"<[^>]+>|\s+", " ", exc.read(2000).decode("utf-8", "replace")).strip()
        record(name, "anchi:" in body, f"status {exc.code}: {body[-160:]}")
    except Exception as exc:  # noqa: BLE001
        record(name, True, f"blocked: {type(exc).__name__}: {exc}")


via_proxy_must_fail("SSRF via proxy: VM sshd 127.0.0.1:22", "http://127.0.0.1:22/")
via_proxy_must_fail("SSRF via proxy: VM mitmdump 127.0.0.1:18080", "http://127.0.0.1:18080/")
via_proxy_must_fail("SSRF via proxy: Lima host gateway 192.168.5.2", "http://192.168.5.2/")
via_proxy_must_fail("SSRF via proxy: cloud metadata 169.254.169.254", "http://169.254.169.254/")
print(json.dumps(results, indent=1))
