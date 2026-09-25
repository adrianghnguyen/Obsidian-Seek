#!/usr/bin/env bash
# Ephemeral Obsidian E2E for GHA — F3 minimal, F2, F4 on seek-functional vault.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

PLUGIN_DEV_DIR="${OBSIDIAN_PLUGIN_DEV_DIR:-/agent/repos/obsidian-plugin-development}"
VAULT_NAME="${SEEK_E2E_VAULT:-seek-functional}"
CATALOG="$ROOT/.cursor/skills/seek-playbook-catalog"
RUN_SCENARIO="$CATALOG/scripts/run-scenario.ps1"

if [[ ! -d "$PLUGIN_DEV_DIR/scripts/cloud-e2e" ]]; then
  echo "obsidian-plugin-development not found at $PLUGIN_DEV_DIR — skipping Obsidian E2E (stub pass for fork without secret checkout)"
  exit 0
fi

# shellcheck source=/dev/null
source "$PLUGIN_DEV_DIR/scripts/cloud-e2e/paths.env" 2>/dev/null || true

bash "$PLUGIN_DEV_DIR/scripts/cloud-e2e/env-install.sh"
bash "$PLUGIN_DEV_DIR/scripts/cloud-e2e/env-start.sh"

PLUGIN_DEST="${SEEK_CLOUD_VAULT_ROOT:-/tmp/seek-e2e-vault}/.obsidian/plugins/seek"
mkdir -p "$PLUGIN_DEST"
cp main.js manifest.json styles.css "$PLUGIN_DEST/"

if ! command -v pwsh >/dev/null 2>&1; then
  echo "PowerShell (pwsh) required for playbook drivers"
  exit 1
fi

pwsh -File "$RUN_SCENARIO" -Id F3 -Vault "$VAULT_NAME" -FixtureSet minimal -AllQueryCases
pwsh -File "$RUN_SCENARIO" -Id F2 -Vault "$VAULT_NAME"
pwsh -File "$RUN_SCENARIO" -Id F4 -Vault "$VAULT_NAME"

echo "Functional E2E bundle completed"
