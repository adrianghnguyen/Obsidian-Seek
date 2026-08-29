param(
    [string]$Vault = 'Obsidian',
    [int]$SampleIndex = 1
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..\..')).Path
$shotDir = Join-Path $repoRoot '.cursor\telemetry-screenshots\F9'
New-Item -ItemType Directory -Force -Path $shotDir | Out-Null
$shotPath = Join-Path $shotDir "F9-sample$SampleIndex-stub-$(Get-Date -Format 'yyyyMMdd-HHmmss').png"

$traceDir = Join-Path $repoRoot '.cursor\functional-traces\F9'
New-Item -ItemType Directory -Force -Path $traceDir | Out-Null
$tracePath = Join-Path $traceDir "F9-sample$SampleIndex-$(Get-Date -Format 'yyyyMMdd-HHmmss').json"

@{
    scenarioId = 'F9'
    status     = 'stub'
    note       = 'Modal early name paint — implement with dev:screenshot + DOM eval'
    screenshotPaths = @($shotPath)
    query      = 'alex che'
} | ConvertTo-Json -Depth 4 | Set-Content $tracePath

Write-Host "STUB F9 — trace written with screenshot path ref: $shotPath"
Write-Host "Trace: $tracePath"
Write-Error "STUB F9 modal early paint — driver not complete"
exit 1
