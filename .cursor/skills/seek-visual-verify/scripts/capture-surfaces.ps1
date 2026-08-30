# Capture Obsidian UI surfaces for Seek visual verification (serial CLI only).
#
# Usage:
#   .\capture-surfaces.ps1 -Vault Obsidian -Surface Main
#   .\capture-surfaces.ps1 -Vault plugin-sandbox-Obsidian -Surface StatusBar, Settings
#   .\capture-surfaces.ps1 -Vault Obsidian -Surface SearchModal -NoLaunch
#
# See ../SKILL.md for when each surface is required.

param(
    [ValidateSet('Obsidian', 'plugin-sandbox-Obsidian')]
    [string]$Vault = 'plugin-sandbox-Obsidian',
    [ValidateSet('Main', 'StatusBar', 'Settings', 'SearchModal')]
    [string[]]$Surface = @('Main'),
    [string]$PluginId = 'seek',
    [string]$OutputDir = '',
    [int]$CliTimeoutSec = 15,
    [int]$OpenWaitSec = 5,
    [int]$UiSettleSec = 2,
    [int]$LaunchWaitSec = 120,
    [switch]$NoLaunch
)

$ErrorActionPreference = 'Stop'
$lib = Join-Path $PSScriptRoot '..\..\seek-cli-startup-debug\scripts\lib\ObsidianCliSerial.ps1'
. $lib

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..')).Path
if (-not $OutputDir) {
    $OutputDir = Join-Path $repoRoot ".seek-artifacts\visual-$Vault"
}

$surfaceFiles = @{
    Main         = 'main.png'
    StatusBar    = 'status-bar.png'
    Settings     = 'seek-settings.png'
    SearchModal  = 'search-modal.png'
}

$DismissUiCode = @'
(() => {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  document.querySelectorAll('.modal-close-button').forEach(b => b.click());
  if (app.setting?.close) app.setting.close();
  return 'cleared';
})()
'@

function Prepare-ObsidianSurface {
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet('Main', 'StatusBar', 'Settings', 'SearchModal')]
        [string]$Name
    )

    switch ($Name) {
        'Main' {
            Invoke-ObsidianEvalSerial -Vault $Vault -Code $DismissUiCode -TimeoutSec $CliTimeoutSec | Out-Null
        }
        'StatusBar' {
            Invoke-ObsidianEvalSerial -Vault $Vault -Code $DismissUiCode -TimeoutSec $CliTimeoutSec | Out-Null
        }
        'Settings' {
            Invoke-ObsidianEvalSerial -Vault $Vault -Code $DismissUiCode -TimeoutSec $CliTimeoutSec | Out-Null
            $settingsCode = @"
app.commands.executeCommandById('app:open-settings');
const t = (app.setting.pluginTabs || []).find(x => x.id === '$PluginId');
if (t) { t.display(); 'ok' } else { 'no-tab' }
"@
            $r = Invoke-ObsidianEvalSerial -Vault $Vault -Code $settingsCode -TimeoutSec $CliTimeoutSec
            if ($r -ne 'ok') { Write-Warning "Settings tab for $PluginId : $r" }
        }
        'SearchModal' {
            Invoke-ObsidianEvalSerial -Vault $Vault -Code $DismissUiCode -TimeoutSec $CliTimeoutSec | Out-Null
            Invoke-ObsidianEvalSerial -Vault $Vault -Code "app.commands.executeCommandById('${PluginId}:search'); 'ok'" -TimeoutSec $CliTimeoutSec | Out-Null
        }
    }
    Start-Sleep -Seconds $UiSettleSec
}

Write-Host "=== capture-surfaces vault=$Vault surfaces=$($Surface -join ',') ==="

Write-Host '[1/4] Ensuring Obsidian + CLI ready...'
Ensure-ObsidianVaultReady -Vault $Vault -CliTimeoutSec $CliTimeoutSec -LaunchWaitSec $LaunchWaitSec -NoLaunch:$NoLaunch

Write-Host "[2/4] Focusing vault via URI (wait ${OpenWaitSec}s)..."
Open-ObsidianVault -Vault $Vault -WaitSec $OpenWaitSec

$name = Invoke-ObsidianEvalSerial -Vault $Vault -Code 'app.vault.getName()' -TimeoutSec $CliTimeoutSec
Write-Host "      vault name: $name"
if ($name -ne $Vault) {
    Write-Warning "Focused vault is '$name', expected '$Vault' - continue anyway"
}

Write-Host '[3/4] Focusing Obsidian window...'
Focus-ObsidianWindow

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
$captured = @()

foreach ($s in ($Surface | Select-Object -Unique)) {
    Write-Host "[4/4] Surface $s ..."
    Prepare-ObsidianSurface -Name $s
    Focus-ObsidianWindow
    $outPath = Join-Path $OutputDir $surfaceFiles[$s]
    Invoke-ObsidianScreenshotSerial -Vault $Vault -Path $outPath -TimeoutSec 30
    Write-Host "      $outPath"
    $captured += $outPath
}

Write-Host '=== capture-surfaces OK ==='
$captured
