#!/bin/sh
# Runs inside the task cell as the agent user. Holds placeholder AWS keys only.
set -u
. /etc/profile.d/anchi-proxy.sh
mkdir -p "$HOME/.aws"
printf '[default]\nregion = %s\noutput = json\n' "$ANCHI_POC_AWS_REGION" >"$HOME/.aws/config"
printf '[default]\naws_access_key_id = AKIAANCHIPLACEHOLDER\naws_secret_access_key = anchi-placeholder\n' >"$HOME/.aws/credentials"

step() { echo; echo "== $1"; shift; "$@" 2>&1 | tail -6; echo "   exit: $?"; }

echo "== whoami: $(id -un); keys in cell: $(grep -c placeholder "$HOME/.aws/credentials") placeholder line(s)"
step "sts get-caller-identity (query protocol; expect success)" aws sts get-caller-identity --query Arn --output text
step "ec2 describe-regions (query protocol, regional)" aws ec2 describe-regions --query 'length(Regions)'
step "logs describe-log-groups (JSON protocol, X-Amz-Target)" aws logs describe-log-groups --limit 3 --query 'logGroups[].logGroupName'
step "s3 ls (REST; AccessDenied from AWS is still a pass)" aws s3 ls
if [ -n "${ANCHI_POC_S3_BUCKET:-}" ]; then
  echo "anchi poc $(date -u +%FT%TZ)" >/tmp/anchi-poc.txt
  step "s3 cp upload to $ANCHI_POC_S3_BUCKET (default checksum mode)" \
    aws s3 cp /tmp/anchi-poc.txt "s3://$ANCHI_POC_S3_BUCKET/anchi-poc/probe.txt"
  step "s3 cp upload, checksums only when required" \
    env AWS_REQUEST_CHECKSUM_CALCULATION=when_required aws s3 cp /tmp/anchi-poc.txt "s3://$ANCHI_POC_S3_BUCKET/anchi-poc/probe.txt"
  step "s3 rm probe object" aws s3 rm "s3://$ANCHI_POC_S3_BUCKET/anchi-poc/probe.txt"
fi
# Deny checks: arguments pass client-side validation but are harmless even if
# the denial failed (nonexistent user, invalid MFA, nonexistent role), so AWS
# itself would refuse to issue anything.
step "iam create-access-key (expect anchi 403)" aws iam create-access-key --user-name anchi-poc-nonexistent-user
step "sts get-session-token (expect anchi 403)" aws sts get-session-token --serial-number arn:aws:iam::000000000000:mfa/anchi-poc-none --token-code 000000
step "sts assume-role (expect anchi 403)" aws sts assume-role --role-arn arn:aws:iam::000000000000:role/anchi-poc-none --role-session-name anchi-poc
