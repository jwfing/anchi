#!/bin/sh
# Runs inside the build cell as cell root. Builds the "aws" agent layer:
# proxy CA trust + AWS CLI v2. Network is only the PoC proxy.
set -eu
RUN=/run/anchi-poc
PROXY=http://127.0.0.1:3128
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

install -m 0644 "$RUN/ca.pem" /usr/local/share/ca-certificates/anchi-proxy.crt
update-ca-certificates >/dev/null
echo "build: CA installed"

printf 'Acquire::http::Proxy "%s";\nAcquire::https::Proxy "%s";\n' "$PROXY" "$PROXY" >/etc/apt/apt.conf.d/90anchi-proxy
if ! ls /etc/apt/sources.list.d/*.sources /etc/apt/sources.list >/dev/null 2>&1; then
  printf 'deb http://deb.debian.org/debian bookworm main\ndeb http://deb.debian.org/debian-security bookworm-security main\n' >/etc/apt/sources.list
fi
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends unzip >/dev/null
rm -rf /var/lib/apt/lists/* /var/cache/apt/*.bin

url="https://awscli.amazonaws.com/awscli-exe-linux-$(uname -m).zip"
python3 - "$url" <<'EOF'
import sys, urllib.request
opener = urllib.request.build_opener(urllib.request.ProxyHandler({"https": "http://127.0.0.1:3128"}))
with opener.open(sys.argv[1], timeout=180) as r, open("/var/tmp/awscli.zip", "wb") as f:
    while chunk := r.read(1 << 20):
        f.write(chunk)
EOF
unzip -q /var/tmp/awscli.zip -d /var/tmp/awscli
/var/tmp/awscli/aws/install >/dev/null
rm -rf /var/tmp/awscli /var/tmp/awscli.zip
echo "build: $(aws --version)"

install -d -o 1000 -g 1000 -m 0700 /home/agent
# AWS CLI v2 bundles its own CA store; point it at the system bundle that
# now includes the proxy CA. Never consult instance metadata.
cat >/etc/profile.d/anchi-proxy.sh <<EOF
export HTTPS_PROXY=$PROXY HTTP_PROXY=$PROXY https_proxy=$PROXY http_proxy=$PROXY
export SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt AWS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt
export AWS_EC2_METADATA_DISABLED=true
EOF
echo "build: done"
