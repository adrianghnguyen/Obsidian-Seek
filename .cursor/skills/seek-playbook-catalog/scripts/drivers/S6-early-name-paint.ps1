param(
    [string]$Vault = 'seek-functional',
    [string]$Query = 'matthew immergut',
    [int]$SampleIndex = 1
)

$ErrorActionPreference = 'Stop'
$lib = Join-Path (Split-Path $PSScriptRoot -Parent) 'lib\Invoke-ObsidianCli.ps1'
. $lib

Write-Host "S6 early name paint - query=`"$Query`" vault=$Vault (eval + onPartial)"

$qSafe = $Query -replace "'", "\'"
$code = "new Promise(async (res)=>{const s=app.plugins.plugins.seek;if(!s?.orchestrator)return res('no-seek');await s.ensureModelLoaded();let partialFired=false;let partialMs=0;const t0=performance.now();const r=await s.orchestrator.search('$qSafe',5,undefined,async()=>{partialFired=true;partialMs=performance.now()-t0});res(JSON.stringify({partialFired,partialMs,nameEarlyPainted:r.entry.nameEarlyPainted,namePartialMs:r.entry.namePartialMs,rank1:r.results[0]?.note_path,count:r.results.length,queryEmbedMs:r.entry.queryEmbedMs}))})"

$start = Get-Date
$raw = Invoke-ObsidianCli -Args @('eval', "vault=$Vault", "code=$code")
$elapsedMs = [math]::Round(((Get-Date) - $start).TotalMilliseconds)

try {
    $evalLine = Get-ObsidianEvalResult -Output $raw
    if ($evalLine -eq 'no-seek') { throw 'no-seek' }
    $parsed = $evalLine | ConvertFrom-Json
} catch {
    Write-Error "Failed to parse S6 eval: $raw"
    exit 1
}

if ($parsed.error) {
    Write-Error "S6 eval error: $($parsed.error)"
    exit 1
}

Write-Host "elapsed=${elapsedMs}ms partialFired=$($parsed.partialFired) namePartialMs=$($parsed.namePartialMs) nameEarlyPainted=$($parsed.nameEarlyPainted) rank1=$($parsed.rank1)"

$ok = ($parsed.partialFired -eq $true) -or ($parsed.nameEarlyPainted -eq $true)
if (-not $ok) {
    Write-Error "Early paint did not fire for `"$Query`" (partialFired=$($parsed.partialFired) nameEarlyPainted=$($parsed.nameEarlyPainted))"
    exit 1
}

if ($parsed.rank1 -notlike '*Matthew Immergut*' -and $Query -like '*immergut*') {
    Write-Error "Rank-1 path unexpected: $($parsed.rank1)"
    exit 1
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..\..')).Path
$traceDir = Join-Path $repoRoot '.cursor\functional-traces\S6'
New-Item -ItemType Directory -Force -Path $traceDir | Out-Null
$tracePath = Join-Path $traceDir "S6-sample$SampleIndex-$(Get-Date -Format 'yyyyMMdd-HHmmss').json"
@{
    scenarioId       = 'S6'
    query              = $Query
    elapsedMs          = $elapsedMs
    partialFired       = $parsed.partialFired
    namePartialMs      = $parsed.namePartialMs
    nameEarlyPainted   = $parsed.nameEarlyPainted
    queryEmbedMs       = $parsed.queryEmbedMs
    count              = $parsed.count
    rank1              = $parsed.rank1
} | ConvertTo-Json -Depth 6 | Set-Content $tracePath

Write-Host "Trace: $tracePath"
exit 0
