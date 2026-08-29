param(
    [string]$Vault = 'plugin-sandbox-Obsidian',
    [string]$Query = 'falsifiability principles progress',
    [string]$ExpectedRank1Contains = 'falsifiability',
    [int]$SampleIndex = 1
)

$ErrorActionPreference = 'Stop'
$lib = Join-Path (Split-Path $PSScriptRoot -Parent) 'lib\Invoke-ObsidianCli.ps1'
$traceLib = Join-Path (Split-Path $PSScriptRoot -Parent) 'lib\Write-ScenarioTrace.ps1'
. $lib
. $traceLib

Write-Host "S5 needle - query=`"$Query`" vault=$Vault"

$start = Get-Date
$raw = Invoke-ObsidianCli -Args @('seek:search', "query=$Query", 'format=json', "vault=$Vault")
$elapsedMs = [math]::Round(((Get-Date) - $start).TotalMilliseconds)

try {
    $parsed = Get-SeekSearchJson -Output $raw
} catch {
    Write-Error "S5 invalid JSON: $raw"
    exit 1
}

if ($parsed.error) {
    Write-Error "S5 search error: $($parsed.error)"
    exit 1
}

$rank1 = @($parsed.results)[0]
$rank1Path = $rank1.path
$count = if ($null -ne $parsed.count) { [int]$parsed.count } else { @($parsed.results).Count }

Write-Host "elapsed=${elapsedMs}ms count=$count rank1=$rank1Path"

$ok = ($count -ge 1) -and ($rank1Path -like "*$ExpectedRank1Contains*")
if (-not $ok) {
    Write-Error "S5 FAIL: expected rank1 containing '$ExpectedRank1Contains' got $rank1Path count=$count"
    exit 1
}

$tracePath = Write-ScenarioTrace -ScenarioId 'S5' -SampleIndex $SampleIndex -Payload @{
    query       = $Query
    elapsedMs   = $elapsedMs
    count       = $count
    rank1Path   = $rank1Path
    expectedRank1Contains = $ExpectedRank1Contains
    gitSha      = Get-GitShaShort
    pass        = $true
}

Write-Host "Trace: $tracePath"
exit 0
