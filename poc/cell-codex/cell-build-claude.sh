#!/bin/sh
# Runs inside the build cell as cell root. Builds the "claude" agent layer:
# proxy CA trust + Claude Code (npm). Network is only the PoC proxy.
set -eu
RUN=/run/anchi-poc
PROXY=http://127.0.0.1:3128
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/opt/node/bin

install -m 0644 "$RUN/ca.pem" /usr/local/share/ca-certificates/anchi-proxy.crt
update-ca-certificates >/dev/null
echo "build: CA installed; node $(node --version)"

export HTTPS_PROXY=$PROXY HTTP_PROXY=$PROXY NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
export npm_config_cache=/var/tmp/npm-cache
npm install -g --prefix /usr/local --no-fund --no-audit "@anthropic-ai/claude-code@${CLAUDE_VERSION:-latest}" >/dev/null
rm -rf /var/tmp/npm-cache
echo "build: $(claude --version 2>&1 | head -1)"

install -d -o 1000 -g 1000 -m 0700 /home/agent
cat >/etc/profile.d/anchi-proxy.sh <<EOF
export HTTPS_PROXY=$PROXY HTTP_PROXY=$PROXY https_proxy=$PROXY http_proxy=$PROXY
export SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
EOF
echo "build: done"
