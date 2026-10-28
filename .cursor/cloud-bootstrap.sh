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

ROOT=/agent/repos
ORCH="$ROOT/obsidian-plugin-development"
BOOT=""

if [ -f /workspace/scripts/cloud-e2e/bootstrap-cloud-repos.sh ]; then
  BOOT=/workspace/scripts/cloud-e2e/bootstrap-cloud-repos.sh
elif [ -f "$ORCH/scripts/cloud-e2e/bootstrap-cloud-repos.sh" ]; then
  BOOT="$ORCH/scripts/cloud-e2e/bootstrap-cloud-repos.sh"
else
  mkdir -p "$ROOT"
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

case "$CMD" in
  install) exec bash "$ORCH/scripts/cloud-e2e/env-install.sh" ;;
  start) exec bash "$ORCH/scripts/cloud-e2e/env-start.sh" ;;
esac
