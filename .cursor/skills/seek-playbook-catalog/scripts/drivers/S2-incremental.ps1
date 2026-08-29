param(
    [string]$Vault = 'Obsidian',
    [int]$SampleIndex = 1
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..\..')).Path
$fixtureScript = Join-Path $repoRoot '.cursor\skills\seek-cli-startup-debug\scripts\prepare-g2-fresh-id-fixture.ps1'
$probeScript = Join-Path $repoRoot '.cursor\skills\seek-cli-startup-debug\scripts\startup-trace-probe.ps1'
$traceLib = Join-Path (Split-Path $PSScriptRoot -Parent) 'lib\Write-ScenarioTrace.ps1'
. $traceLib

Write-Host "S2 incremental - G2 fixture + cold restart vault=$Vault"

if (-not (Test-Path $fixtureScript)) { Write-Error "G2 fixture script missing"; exit 1 }
& $fixtureScript -Vault $Vault
if ($LASTEXITCODE -ne 0) { exit 1 }

$start = Get-Date
& $probeScript -Run A -Vault $Vault -PathId "S2-sample$SampleIndex" -MaxSeconds 180
$probeExit = $LASTEXITCODE
$probeSec = [math]::Round(((Get-Date) - $start).TotalSeconds, 1)

if ($probeExit -ne 0) {
    Write-Error "S2 startup probe failed exit=$probeExit"
    exit 1
}

$tracePath = Write-ScenarioTrace -ScenarioId 'S2' -SampleIndex $SampleIndex -Payload @{
    probeSec = $probeSec
    fixture  = 'g2-fresh-id'
    gitSha   = Get-GitShaShort
    pass     = $true
}

Write-Host "S2 PASS probeSec=$probeSec"
Write-Host "Trace: $tracePath"
exit 0
