param(
    [string]$Vault = 'plugin-sandbox-Obsidian',
    [ValidateSet('A', 'B')]
    [string]$Run = 'A',
    [int]$SampleIndex = 1
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..\..')).Path
$probeScript = Join-Path $repoRoot '.cursor\skills\seek-cli-startup-debug\scripts\startup-trace-probe.ps1'

if (-not (Test-Path $probeScript)) {
    Write-Error "startup-trace-probe.ps1 not found: $probeScript"
    exit 1
}

Write-Host "S1 cold start — delegating to startup-trace-probe Run $Run vault=$Vault sample=$SampleIndex"
& $probeScript -Run $Run -Vault $Vault -PathId "S1-sample$SampleIndex"
exit $LASTEXITCODE
