#!/usr/bin/env bash
# Optional: notify Cursor Automation / repository_dispatch to run the e2e-triage agent.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

if [[ -z "${CURSOR_E2E_TRIAGE_DISPATCH_URL:-}" ]]; then
  echo "CURSOR_E2E_TRIAGE_DISPATCH_URL not set — skipping agent dispatch (script triage only)"
  exit 0
fi

PR="${GITHUB_EVENT_NUMBER:-${PR_NUMBER:-}}"
SHA="${GITHUB_SHA:-$(git rev-parse HEAD)}"
RUN_ID="${GITHUB_RUN_ID:-local}"

payload=$(jq -n \
  --arg pr "$PR" \
  --arg sha "$SHA" \
  --arg runId "$RUN_ID" \
  --arg repo "${GITHUB_REPOSITORY:-}" \
  '{event:"e2e-triage", pull_request_number: ($pr|tonumber?), head_sha: $sha, workflow_run_id: $runId, repository: $repo}')

curl -sfS -X POST \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${CURSOR_E2E_TRIAGE_DISPATCH_TOKEN:-}" \
  -d "$payload" \
  "$CURSOR_E2E_TRIAGE_DISPATCH_URL"

echo "Dispatched e2e-triage agent for PR ${PR:-unknown}"
