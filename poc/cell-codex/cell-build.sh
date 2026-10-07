#!/bin/sh
# Runs inside the build cell as cell root. Network is only the PoC proxy.
set -eu
RUN=/run/anchi-poc
PROXY=http://127.0.0.1:3128
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/opt/node/bin

# Trust the proxy CA system-wide so every TLS client in the image accepts it.
install -m 0644 "$RUN/ca.pem" /usr/local/share/ca-certificates/anchi-proxy.crt
update-ca-certificates >/dev/null
echo "build: CA installed"

printf 'Acquire::http::Proxy "%s";\nAcquire::https::Proxy "%s";\n' "$PROXY" "$PROXY" >/etc/apt/apt.conf.d/90anchi-proxy
if ! ls /etc/apt/sources.list.d/*.sources /etc/apt/sources.list >/dev/null 2>&1; then
  printf 'deb http://deb.debian.org/debian bookworm main\ndeb http://deb.debian.org/debian-security bookworm-security main\n' >/etc/apt/sources.list
fi
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends git >/dev/null
rm -rf /var/lib/apt/lists/* /var/cache/apt/*.bin
echo "build: $(git --version)"

url="https://github.com/openai/codex/releases/download/rust-v$CODEX_VERSION/codex-$CODEX_TARGET.tar.gz"
python3 - "$url" <<'EOF'
import sys, urllib.request
opener = urllib.request.build_opener(urllib.request.ProxyHandler({"https": "http://127.0.0.1:3128"}))
with opener.open(sys.argv[1], timeout=120) as r, open("/var/tmp/codex.tgz", "wb") as f:
    while chunk := r.read(1 << 20):
        f.write(chunk)
EOF
tar -xzf /var/tmp/codex.tgz -C /var/tmp
install -m 0755 "/var/tmp/codex-$CODEX_TARGET" /usr/local/bin/codex
rm -f /var/tmp/codex.tgz "/var/tmp/codex-$CODEX_TARGET"
echo "build: $(codex --version)"

# Image-wide client settings: everything goes through the cell forwarder.
cat >/etc/profile.d/anchi-proxy.sh <<EOF
export HTTPS_PROXY=$PROXY HTTP_PROXY=$PROXY https_proxy=$PROXY http_proxy=$PROXY
export SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
EOF
git config --system url."https://github.com/".insteadOf git@github.com:
git config --system http.proxy "$PROXY"
echo "build: done"
