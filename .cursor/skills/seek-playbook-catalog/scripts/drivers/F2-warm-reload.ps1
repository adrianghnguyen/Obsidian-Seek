param(
    [string]$Vault = 'seek-functional',
    [int]$SampleIndex = 1
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..\..')).Path
$probeScript = Join-Path $repoRoot '.cursor\skills\seek-cli-startup-debug\scripts\startup-trace-probe.ps1'

Write-Host "F2 warm reload - startup-trace-probe Run B vault=$Vault sample=$SampleIndex"
& $probeScript -Run B -Vault $Vault -PathId "F2-sample$SampleIndex"
exit $LASTEXITCODE
