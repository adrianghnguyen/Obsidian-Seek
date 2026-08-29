param(
    [string]$Vault = 'seek-functional',
    [string]$Query = 'alex che',
    [int]$SampleIndex = 1
)

$ErrorActionPreference = 'Stop'
$lib = Join-Path (Split-Path $PSScriptRoot -Parent) 'lib\Invoke-ObsidianCli.ps1'
. $lib

Write-Host "S6 early name paint — query=`"$Query`" vault=$Vault"

$start = Get-Date
$raw = Invoke-ObsidianCli -Args @('seek:search', "query=$Query", 'format=json', "vault=$Vault")
$elapsedMs = [math]::Round(((Get-Date) - $start).TotalMilliseconds)

try {
    $parsed = Get-SeekSearchJson -Output $raw
} catch {
    Write-Error "Failed to parse seek:search JSON: $raw"
    exit 1
}

if ($parsed.error) {
    Write-Error "seek:search error: $($parsed.error)"
    exit 1
}

$first = @($parsed.results)[0]
$namePartialMs = $first.namePartialMs
$nameEarly = $first.nameEarlyPainted

Write-Host "elapsed=${elapsedMs}ms namePartialMs=$namePartialMs nameEarlyPainted=$nameEarly count=$($parsed.count)"

if ($parsed.count -lt 1) {
    Write-Error 'Expected at least one result for name paint probe'
    exit 1
}

if ($nameEarly -ne $true) {
    Write-Warning 'nameEarlyPainted was not true — check query matches known-item fixture'
}

$traceDir = Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..\..')).Path '.cursor\functional-traces\S6'
New-Item -ItemType Directory -Force -Path $traceDir | Out-Null
$tracePath = Join-Path $traceDir "S6-sample$SampleIndex-$(Get-Date -Format 'yyyyMMdd-HHmmss').json"
@{
    scenarioId = 'S6'
    query      = $Query
    elapsedMs  = $elapsedMs
    namePartialMs = $namePartialMs
    nameEarlyPainted = $nameEarly
    count      = $parsed.count
    rank1      = $first.path
} | ConvertTo-Json -Depth 6 | Set-Content $tracePath

Write-Host "Trace: $tracePath"
exit 0
