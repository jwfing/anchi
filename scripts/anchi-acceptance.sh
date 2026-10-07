#!/bin/bash
# Phase 1 end-to-end acceptance with live accounts. Run after `scripts/anchi setup codex` and
# the connectors needed by the chosen scenarios. Real credentials stay in the VM vault; this
# script only names targets.
#
#   ANCHI_REPO=owner/private-repo ANCHI_ISSUE=12     scenario 1 (developer agent: clone, push, PR)
#   ANCHI_LOG_GROUP=/app/prod ANCHI_ISSUE_REPO=o/r    scenario 2 (devops agent: logs → issue)
#   ANCHI_LINEAR_ISSUE=ENG-123                        scenario 3 (Linear agent: read, comment)
#
# Each scenario creates its agent file if missing, runs the task, scans the live cell for real
# credential values (scenario 4) and prints the result and links.
set -euo pipefail
cd "$(dirname "$0")/.."
anchi=scripts/anchi
agents=${ANCHI_HOME:-$HOME/.anchi}/agents
images=${ANCHI_HOME:-$HOME/.anchi}/images
mkdir -p "$agents" "$images"
failures=0

write_if_missing() {
  [[ -f $1 ]] || { cat >"$1"; echo "created $1"; }
}

# run_scenario NAME AGENT LINK-REGEX TEXT: the task must finish, reply with a link matching
# LINK-REGEX (the pull request, issue or comment it created) and pass the credential scan.
run_scenario() {
  local name=$1 agent=$2 link=$3 text=$4 out task
  echo "== $name"
  if ! out=$($anchi run "$agent" "$text"); then
    echo "$out" | tail -20
    echo "FAIL $name: task did not finish"
    failures=$((failures + 1))
    return
  fi
  echo "$out" | tail -8
  task=$(echo "$out" | grep -Eo 't-[0-9a-f]{10}' | tail -1)
  if ! $anchi scan "$task"; then
    echo "FAIL $name: credential scan of $task"
    failures=$((failures + 1))
  elif ! echo "$out" | grep -Eq "$link"; then
    echo "FAIL $name: no link matching $link in the reply ($task)"
    failures=$((failures + 1))
  else
    echo "PASS $name ($task)"
  fi
}

if [[ -n ${ANCHI_REPO:-} && -n ${ANCHI_ISSUE:-} ]]; then
  write_if_missing "$images/node.yaml" <<'EOF'
description: Node.js toolchain
packages: [nodejs, npm]
EOF
  write_if_missing "$agents/developer.yaml" <<'EOF'
name: Developer
runtime: codex
connectors: [github]
image: node
prompt:
  text: |
    You fix GitHub issues. Clone the repository into the work directory (or update an
    existing clone), create a branch, make the smallest correct change with a test when
    practical, commit, push the branch and open a pull request with `gh pr create` that
    references the issue. Reply with the pull request URL.
EOF
  run_scenario 'scenario 1: developer agent' developer "github\.com/$ANCHI_REPO/pull/[0-9]+" \
    "Fix issue #$ANCHI_ISSUE in https://github.com/$ANCHI_REPO (private repository)."
fi

if [[ -n ${ANCHI_LOG_GROUP:-} && -n ${ANCHI_ISSUE_REPO:-} ]]; then
  write_if_missing "$images/awscli.yaml" <<'EOF'
description: AWS CLI v2
packages: [unzip]
run:
  - curl -fsSL -o /tmp/awscliv2.zip "https://awscli.amazonaws.com/awscli-exe-linux-$(uname -m).zip"
  - cd /tmp && unzip -q awscliv2.zip && ./aws/install && rm -rf /tmp/aws /tmp/awscliv2.zip
EOF
  write_if_missing "$agents/devops.yaml" <<'EOF'
name: DevOps
runtime: codex
connectors: [aws, github]
image: awscli
prompt:
  text: |
    You investigate production errors. Read CloudWatch logs with the AWS CLI, group the
    errors, and file one GitHub issue with `gh issue create` summarizing them with counts,
    examples and likely causes. Reply with the issue URL.
EOF
  run_scenario 'scenario 2: devops agent' devops "github\.com/$ANCHI_ISSUE_REPO/issues/[0-9]+" \
    "Summarize the errors of the last 24 hours in log group $ANCHI_LOG_GROUP and file an issue in https://github.com/$ANCHI_ISSUE_REPO."
fi

if [[ -n ${ANCHI_LINEAR_ISSUE:-} ]]; then
  write_if_missing "$agents/linear.yaml" <<'EOF'
name: Linear assistant
runtime: codex
connectors: [linear]
prompt:
  text: |
    You work with Linear issues through the GraphQL API at https://api.linear.app/graphql
    using curl with `Authorization: $LINEAR_API_KEY`. Read the issue you are given and add a
    helpful comment (commentCreate). Reply with the comment URL.
EOF
  run_scenario 'scenario 3: Linear agent' linear 'linear\.app/[^ ]+/issue/[^ ]+#comment-' \
    "Read Linear issue $ANCHI_LINEAR_ISSUE and add a comment that summarizes it and proposes next steps."
fi

echo "== scenario 5: isolation regression"
make verify-anchi || failures=$((failures + 1))
echo "failures: $failures"
exit "$failures"
