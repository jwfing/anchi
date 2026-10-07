#!/bin/bash
# Guest root. Runs AWS CLI calls as the agent user in a task cell built from
# the "aws" layer. The proxy re-signs SigV4 requests; real keys only come
# from ANCHI_POC_AWS_* in this script's environment (fake otherwise).
#   ANCHI_POC_AWS_REGION  default us-east-2
#   ANCHI_POC_S3_BUCKET   optional bucket for an upload/delete probe
set -euo pipefail
[[ $(id -u) == 0 ]] || { echo 'run as guest root' >&2; exit 1; }
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=poc/cell-codex/lib.sh
source "$here/lib.sh"
layer=$POC/layers/aws/upper
image=$POC/images/aws
[[ -L $layer/usr/local/bin/aws ]] || { echo "build the aws layer first" >&2; exit 1; }

cleanup() {
  mountpoint -q "$image" && umount "$image"
  proxy_down
}
trap cleanup EXIT
install -d -m 0755 "$image"
mountpoint -q "$image" || mount -t overlay overlay -o "ro,lowerdir=$layer:$BASE" "$image"
if [[ -z ${ANCHI_POC_AWS_ACCESS_KEY_ID:-} ]]; then
  export ANCHI_POC_AWS_ACCESS_KEY_ID=AKIAFAKENOTREAL00000 ANCHI_POC_AWS_SECRET_ACCESS_KEY=fake-not-real
  echo "proxy: using FAKE AWS keys"
fi
proxy_up
install -m 0644 "$here/cell-run-aws.sh" "$RUN/"

cell_flags "$image"
"${CELL[@]}" --volatile=overlay --machine=anchi-poc-aws --user=agent --drop-capability=all \
  --tmpfs=/tmp:mode=1777,size=256M --setenv=HOME=/home/agent \
  --setenv=ANCHI_POC_AWS_REGION="${ANCHI_POC_AWS_REGION:-us-east-2}" \
  --setenv=ANCHI_POC_S3_BUCKET="${ANCHI_POC_S3_BUCKET:-}" \
  -- /bin/sh -c "$FWD sh $RUN/cell-run-aws.sh" || echo "== cell exited non-zero"
echo
echo "== proxy log"
proxy_log
