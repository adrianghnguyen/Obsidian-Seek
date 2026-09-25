#!/usr/bin/env bash
# Wait for needs-e2e or skip-e2e on the PR; on timeout apply script decision from triage.json.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

TIMEOUT=600
while [[ $# -gt 0 ]]; do
  case "$1" in
    --timeout) TIMEOUT="$2"; shift 2 ;;
    *) shift ;;
  esac
done

PR="${GITHUB_EVENT_NUMBER:-${PR_NUMBER:-}}"
TRIAGE="${TRIAGE_JSON:-triage.json}"

if [[ -z "$PR" ]]; then
  echo "No PR number — skipping label wait"
  exit 0
fi

has_decision_label() {
  gh pr view "$PR" --json labels -q '.labels[].name' 2>/dev/null | grep -qxE 'needs-e2e|skip-e2e'
}

deadline=$((SECONDS + TIMEOUT))
while (( SECONDS < deadline )); do
  if has_decision_label; then
    echo "PR $PR has E2E decision label"
    gh pr view "$PR" --json labels -q '.labels[].name' | grep -E 'needs-e2e|skip-e2e' || true
    exit 0
  fi
  sleep 15
done

echo "Timeout waiting for agent labels — applying script decision (fail-closed on review)"
DECISION=$(jq -r '.decision' "$TRIAGE")
case "$DECISION" in
  require) LABEL=needs-e2e ;;
  skip) LABEL=skip-e2e ;;
  *) LABEL=needs-e2e ;;
esac
gh label create "$LABEL" --force 2>/dev/null || true
OPP=$([[ "$LABEL" == needs-e2e ]] && echo skip-e2e || echo needs-e2e)
gh label create "$OPP" --force 2>/dev/null || true
gh pr edit "$PR" --remove-label "$OPP" 2>/dev/null || true
gh pr edit "$PR" --add-label "$LABEL"
echo "Applied fallback label: $LABEL"
