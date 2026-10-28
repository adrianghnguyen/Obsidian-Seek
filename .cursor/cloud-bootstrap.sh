#!/usr/bin/env bash
# Entry point for Cloud environment.json install/start (identical across E2E repos).
set -euo pipefail

CMD="${1:-}"
case "$CMD" in
  install | start) ;;
  *)
    echo "usage: $0 install|start" >&2
    exit 2
    ;;
esac

BOOT=""
REPOS_ROOT=""
AGENT_REPOS=/agent/repos
AGENT_BOOT="$AGENT_REPOS/obsidian-plugin-development/scripts/cloud-e2e/bootstrap-cloud-repos.sh"

# Dependency clones already live under /agent/repos on environment builds, even
# when that directory is not writable. Prefer that checkout over $HOME/repos.
if [ -f "$AGENT_BOOT" ]; then
  REPOS_ROOT=$AGENT_REPOS
elif [ -f /tmp/cloud-e2e-repos.env ]; then
  # shellcheck source=/dev/null
  . /tmp/cloud-e2e-repos.env
  REPOS_ROOT=${CLOUD_E2E_REPOS:-}
fi
if [ -z "${REPOS_ROOT:-}" ]; then
  if [ -d "$AGENT_REPOS" ] && [ -w "$AGENT_REPOS" ]; then
    REPOS_ROOT=$AGENT_REPOS
  else
    REPOS_ROOT="${CLOUD_E2E_REPOS:-$HOME/repos}"
  fi
fi
ORCH="$REPOS_ROOT/obsidian-plugin-development"

if [ -f /workspace/scripts/cloud-e2e/bootstrap-cloud-repos.sh ]; then
  BOOT=/workspace/scripts/cloud-e2e/bootstrap-cloud-repos.sh
elif [ -f "$ORCH/scripts/cloud-e2e/bootstrap-cloud-repos.sh" ]; then
  BOOT="$ORCH/scripts/cloud-e2e/bootstrap-cloud-repos.sh"
else
  mkdir -p "$REPOS_ROOT"
  if [ -f /workspace/scripts/cloud-e2e/env-install.sh ]; then
    ln -sfn /workspace "$ORCH"
  fi
  if [ -f "$ORCH/scripts/cloud-e2e/bootstrap-cloud-repos.sh" ]; then
    BOOT="$ORCH/scripts/cloud-e2e/bootstrap-cloud-repos.sh"
  fi
fi

if [ -z "$BOOT" ] || [ ! -f "$BOOT" ]; then
  echo "cloud-bootstrap: bootstrap-cloud-repos.sh not found" >&2
  exit 1
fi

bash "$BOOT"
if [ -f /tmp/cloud-e2e-repos.env ]; then
  # shellcheck source=/dev/null
  . /tmp/cloud-e2e-repos.env
  ORCH="$CLOUD_E2E_REPOS/obsidian-plugin-development"
fi
export CLOUD_E2E_REPOS="${CLOUD_E2E_REPOS:-$REPOS_ROOT}"

case "$CMD" in
  install) exec bash "$ORCH/scripts/cloud-e2e/env-install.sh" ;;
  start) exec bash "$ORCH/scripts/cloud-e2e/env-start.sh" ;;
esac
