param(
    [string]$Vault = 'seek-functional',
    [string]$Query = 'matthew immergut',
    [int]$SampleIndex = 1
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..\..')).Path
$lib = Join-Path (Split-Path $PSScriptRoot -Parent) 'lib\Invoke-ObsidianCli.ps1'
$traceLib = Join-Path (Split-Path $PSScriptRoot -Parent) 'lib\Write-ScenarioTrace.ps1'
. $lib
. $traceLib

$shotDir = Join-Path $repoRoot '.cursor\telemetry-screenshots\F9'
New-Item -ItemType Directory -Force -Path $shotDir | Out-Null
$shotPath = Join-Path $shotDir "F9-sample$SampleIndex-$(Get-Date -Format 'yyyyMMdd-HHmmss').png"

Write-Host "F9 modal early paint - vault=$Vault query=`"$Query`""

$qSafe = $Query -replace "'", "\'"
$code = @"
new Promise(async (res)=>{
  const s=app.plugins.plugins.seek;
  if(!s?.orchestrator) return res(JSON.stringify({ok:false,reason:'no-seek'}));
  await s.ensureModelLoaded();
  let partialFired=false;
  let partialMs=0;
  const t0=performance.now();
  s.openSearchModal('$qSafe');
  const modalInst=s._searchModal ?? null;
  await new Promise(r=>setTimeout(r,2500));
  const row=document.querySelector('.seek-results .seek-result,.modal .seek-result');
  const rowText=row?.textContent?.slice(0,80)??'';
  partialMs=performance.now()-t0;
  partialFired=!!row;
  res(JSON.stringify({
    ok: partialFired && rowText.toLowerCase().includes('matthew'),
    partialFired, partialMs, rowText
  }));
})
"@ -replace "`r`n", ' '

$start = Get-Date
$raw = Invoke-ObsidianCli -Args @('eval', "vault=$Vault", "code=$code")
$parsed = Get-ObsidianEvalResult -Output $raw | ConvertFrom-Json
Invoke-ObsidianCli -Args @('dev:screenshot', "path=$shotPath", "vault=$Vault") | Out-Null
$elapsedMs = [math]::Round(((Get-Date) - $start).TotalMilliseconds)

Write-Host "elapsed=${elapsedMs}ms partialFired=$($parsed.partialFired) rowText=$($parsed.rowText)"

if (-not $parsed.ok) {
    Write-Error "F9 FAIL: $($parsed | ConvertTo-Json -Compress)"
    exit 1
}

$tracePath = Write-ScenarioTrace -ScenarioId 'F9' -SampleIndex $SampleIndex -Payload @{
    query           = $Query
    elapsedMs       = $elapsedMs
    partialFired    = $parsed.partialFired
    partialMs       = $parsed.partialMs
    rowText         = $parsed.rowText
    screenshotPath  = $shotPath
    gitSha          = Get-GitShaShort
    pass            = $true
}

Write-Host "Trace: $tracePath"
exit 0
