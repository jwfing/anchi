#!/bin/bash
# Run one client through the proxy with placeholder credentials and an isolated
# HOME, then summarize what the proxy saw. Holds no real credentials.
#   run-client.sh claude|codex|gh|git|aws
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
target=${1:?usage: run-client.sh claude|codex|gh|git|aws}
port=${ANCHI_POC_PORT:-18080}
ca="$here/out/mitm/mitmproxy-ca-cert.pem"
[[ -f $ca ]] || { echo "CA not found; start the proxy first" >&2; exit 1; }
home="$here/out/home-$target"
rm -rf "$home" && mkdir -p "$home"

export HOME="$home" XDG_CONFIG_HOME="$home/.config"
export HTTPS_PROXY="http://127.0.0.1:$port" HTTP_PROXY="http://127.0.0.1:$port"
export https_proxy=$HTTPS_PROXY http_proxy=$HTTP_PROXY NO_PROXY="" no_proxy=""
export NODE_EXTRA_CA_CERTS="$ca" SSL_CERT_FILE="$ca" REQUESTS_CA_BUNDLE="$ca" \
  AWS_CA_BUNDLE="$ca" CODEX_CA_CERTIFICATE="$ca" GIT_SSL_CAINFO="$ca"
since=$(date +%s)

case $target in
  claude)
    export CLAUDE_CODE_OAUTH_TOKEN="sk-ant-oat01-anchi-placeholder"
    unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN
    claude -p "Reply with exactly: hi" --max-turns 1
    ;;
  codex)
    export CODEX_HOME="$home/.codex"
    "$here/.venv/bin/python" "$here/make_placeholders.py" codex "$CODEX_HOME"
    codex exec --skip-git-repo-check --sandbox read-only "Reply with exactly: hi" </dev/null
    ;;
  gh)
    export GH_TOKEN="anchi-placeholder" GH_CONFIG_DIR="$home/.config/gh"
    echo "== gh api user"; gh api user --jq .login
    echo "== curl api.github.com/user (CA-explicit fallback)"
    curl -sS --cacert "$ca" -H "Authorization: Bearer anchi-placeholder" https://api.github.com/user | head -c 200; echo
    echo "== deny check: POST /user/keys (expect 403 from anchi)"
    curl -sS --cacert "$ca" -X POST -d '{}' https://api.github.com/user/keys; echo
    ;;
  git)
    repo=${ANCHI_POC_REPO:-jwfing/secure-vm}
    export GIT_TERMINAL_PROMPT=0 GIT_CONFIG_GLOBAL="$home/.gitconfig"
    git config --global url."https://github.com/".insteadOf git@github.com:
    git -c credential.helper= clone --depth 1 "git@github.com:$repo.git" "$home/clone" && git -C "$home/clone" log --oneline -1
    ;;
  aws)
    export AWS_CONFIG_FILE="$home/.aws/config" AWS_SHARED_CREDENTIALS_FILE="$home/.aws/credentials"
    mkdir -p "$home/.aws"
    printf '[default]\nregion = %s\n' "${ANCHI_POC_AWS_REGION:-us-east-2}" >"$AWS_CONFIG_FILE"
    printf '[default]\naws_access_key_id = AKIAANCHIPLACEHOLDER\naws_secret_access_key = anchi-placeholder\n' >"$AWS_SHARED_CREDENTIALS_FILE"
    echo "== sts get-caller-identity (expect success)"; aws sts get-caller-identity
    echo "== s3 ls (expect success or AccessDenied from AWS, not from anchi)"; aws s3 ls | head -5
    # Deny checks use arguments that are harmless even if the denial failed:
    # a nonexistent user, and an invalid duration that AWS rejects.
    echo "== iam create-access-key (expect anchi 403)"; aws iam create-access-key --user-name anchi-poc-nonexistent-user
    echo "== sts get-session-token (expect anchi 403)"; aws sts get-session-token --duration-seconds 1
    ;;
  *) echo "unknown target $target" >&2; exit 2 ;;
esac
status=$?
echo
echo "== exit status: $status"
"$here/.venv/bin/python" "$here/summarize.py" "$since"
