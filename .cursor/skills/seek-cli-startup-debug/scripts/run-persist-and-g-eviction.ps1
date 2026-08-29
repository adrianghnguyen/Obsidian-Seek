# Wait for index ready, verify IDB persists across restart, run G_eviction steady probe.
param(
    [string]$Vault = 'Obsidian',
    [int]$MinChunks = 15000,
    [int]$TimeoutMinutes = 60
)

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host '=== Step 1: poll until ui ok ==='
& powershell -NoProfile -File (Join-Path $scriptDir 'poll-index-until-ready.ps1') -Vault $Vault -MinChunks $MinChunks -TimeoutMinutes $TimeoutMinutes
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host '=== Step 2: restart persistence check ==='
& obsidian restart "vault=$Vault" | Out-Null
Start-Sleep -Seconds 45
$persist = (& obsidian eval "vault=$Vault" 'code=(async()=>{const c=await app.plugins.plugins.seek.store.count();const s=await app.plugins.plugins.seek.getIndexStats();return JSON.stringify({afterRestart:c.chunks,files:s.files,ui:app.plugins.plugins.seek.indexUiHealth});})()' 2>&1 | Out-String).Trim()
Write-Host "PERSIST $persist"
if ($persist -notmatch '"afterRestart":(\d+)' -or [int]$Matches[1] -lt 10000) { exit 1 }

Write-Host '=== Step 3: G_eviction steady probe ==='
& powershell -NoProfile -File (Join-Path $scriptDir 'probe-g-eviction-steady.ps1') -Vault $Vault
exit $LASTEXITCODE
