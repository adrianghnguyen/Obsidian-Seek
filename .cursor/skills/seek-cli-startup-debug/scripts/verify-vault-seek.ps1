# Serial vault verify: ensure Obsidian (launch if needed) -> open vault -> copy (optional) -> reload -> eval.
# Visual screenshots are NOT part of this script — use seek-visual-verify skill + capture-surfaces.ps1.
# One obsidian command at a time - never run this script in parallel with other CLI.
#
# Usage:
#   .\verify-vault-seek.ps1 -Vault plugin-sandbox-Obsidian
#   .\verify-vault-seek.ps1 -Vault Obsidian -CopyFromRepo
#   .\verify-vault-seek.ps1 -Vault plugin-sandbox-Obsidian -NoLaunch   # fail if Obsidian not running

param(
    [ValidateSet('Obsidian', 'plugin-sandbox-Obsidian')]
    [string]$Vault = 'plugin-sandbox-Obsidian',
    [string]$PluginId = 'seek',
    [switch]$CopyFromRepo,
    [int]$CliTimeoutSec = 15,
    [int]$OpenWaitSec = 5,
    [int]$ReloadWaitSec = 4,
    [int]$LaunchWaitSec = 120,
    [switch]$NoLaunch
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib\ObsidianCliSerial.ps1')

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..')).Path
$vaultPath = $script:KnownVaults[$Vault]
if (-not $vaultPath) { throw "Unknown vault: $Vault" }
$pluginDir = Join-Path $vaultPath ".obsidian\plugins\$PluginId"

Write-Host "=== verify-vault-seek vault=$Vault plugin=$PluginId ==="

# 1. Launch Obsidian if needed; wait until CLI responds for this vault.
Write-Host '[1/5] Ensuring Obsidian + CLI ready...'
Ensure-ObsidianVaultReady -Vault $Vault -CliTimeoutSec $CliTimeoutSec -LaunchWaitSec $LaunchWaitSec -NoLaunch:$NoLaunch

# 2. Focus target vault (URI - not app:open-vault picker).
Write-Host "[2/5] Focusing vault via URI (wait ${OpenWaitSec}s)..."
Open-ObsidianVault -Vault $Vault -WaitSec $OpenWaitSec

$name = Invoke-ObsidianEvalSerial -Vault $Vault -Code 'app.vault.getName()' -TimeoutSec $CliTimeoutSec
Write-Host "      vault name: $name"
if ($name -ne $Vault) {
    Write-Warning "Focused vault is '$name', expected '$Vault' - continue anyway"
}

# 3. Optional deploy from repo build.
if ($CopyFromRepo) {
    Write-Host '[3/5] Copying artifacts from repo...'
    $hash = Copy-SeekPluginArtifacts -RepoRoot $repoRoot -VaultPluginDir $pluginDir
    Write-Host "      main.js $hash"
} else {
    Write-Host '[3/5] Skipping copy (-CopyFromRepo to deploy from repo)'
    if (-not (Test-Path (Join-Path $pluginDir 'main.js'))) {
        throw ('No plugin at {0}. Use -CopyFromRepo or copy manually.' -f $pluginDir)
    }
}

# 4. Reload plugin (retry once if CLI was still settling).
Write-Host "[4/5] plugin:reload id=$PluginId..."
$reloadOut = ''
foreach ($attempt in 1..2) {
    try {
        $reloadOut = Invoke-ObsidianCliSerial -Args @('plugin:reload', "id=$PluginId", "vault=$Vault") -TimeoutSec 30
        break
    } catch {
        if ($attempt -eq 2) { throw }
        Write-Host '      reload failed, retrying after 3s...'
        Start-Sleep -Seconds 3
    }
}
Write-Host "      $reloadOut"
Start-Sleep -Seconds $ReloadWaitSec

# 5. Runtime probe.
Write-Host '[5/5] Seek runtime probe...'
$probe = Invoke-ObsidianEvalSerial -Vault $Vault -TimeoutSec $CliTimeoutSec -Code @'
JSON.stringify({
  vault: app.vault.getName(),
  version: app.plugins.plugins.seek?.manifest?.version,
  health: app.plugins.plugins.seek?.indexUiHealth,
  warmPhase: app.plugins.plugins.seek?.indexWarmPhase,
  job: app.plugins.plugins.seek?.getIndexJob?.()
})
'@
Write-Host "      $probe"

Write-Host '=== verify-vault-seek OK ==='
Write-Host 'For UI/CSS proof, run .cursor/skills/seek-visual-verify/scripts/capture-surfaces.ps1 (see SKILL.md).'
