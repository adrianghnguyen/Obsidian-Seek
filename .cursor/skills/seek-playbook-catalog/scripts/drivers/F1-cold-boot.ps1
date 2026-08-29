param(
    [string]$Vault = 'plugin-sandbox-Obsidian',
    [int]$SampleIndex = 1
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..\..')).Path
$probeScript = Join-Path $repoRoot '.cursor\skills\seek-cli-startup-debug\scripts\startup-trace-probe.ps1'
$lib = Join-Path (Split-Path $PSScriptRoot -Parent) 'lib\Invoke-ObsidianCli.ps1'
$traceLib = Join-Path (Split-Path $PSScriptRoot -Parent) 'lib\Write-ScenarioTrace.ps1'
. $lib
. $traceLib

Write-Host "F1 cold boot - startup probe Run A + search ready vault=$Vault"

if (-not (Test-Path $probeScript)) {
    Write-Error "startup-trace-probe.ps1 not found"
    exit 1
}

$start = Get-Date
& $probeScript -Run A -Vault $Vault -PathId "F1-sample$SampleIndex" -MaxSeconds 180
$probeExit = $LASTEXITCODE
$probeSec = [math]::Round(((Get-Date) - $start).TotalSeconds, 1)

if ($probeExit -ne 0) {
    Write-Error "F1 startup probe failed exit=$probeExit"
    exit 1
}

$searchStart = Get-Date
$raw = Invoke-ObsidianCli -Args @('seek:search', 'query=notes', 'format=json', "vault=$Vault")
$searchMs = [math]::Round(((Get-Date) - $searchStart).TotalMilliseconds)

try {
    $parsed = Get-SeekSearchJson -Output $raw
} catch {
    Write-Error "F1 search JSON invalid: $raw"
    exit 1
}

if ($parsed.error) {
    Write-Error "F1 search not ready: $($parsed.error)"
    exit 1
}

$count = if ($null -ne $parsed.count) { [int]$parsed.count } else { @($parsed.results).Count }
if ($count -lt 1) {
    Write-Error "F1 search returned no results after cold boot"
    exit 1
}

$tracePath = Write-ScenarioTrace -ScenarioId 'F1' -SampleIndex $SampleIndex -Payload @{
    probeSec    = $probeSec
    searchMs    = $searchMs
    resultCount = $count
    gitSha      = Get-GitShaShort
    pass        = $true
}

Write-Host "F1 PASS probeSec=$probeSec searchMs=$searchMs count=$count"
Write-Host "Trace: $tracePath"
exit 0
