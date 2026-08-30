# Run F1–F10 with N samples each; writes playbook-run-results.json for F2/S1 batch metrics.
param(
    [int]$Samples = 3,
    [int]$FromSample = 1,
    [int]$MaxRetries = 1,
    [string[]]$SkipIds = @('F3')
)

$ErrorActionPreference = 'Continue'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..')).Path
$runScenario = Join-Path $PSScriptRoot 'run-scenario.ps1'
$registryPath = Join-Path (Split-Path $PSScriptRoot -Parent) 'playbook-scenarios.json'
$resultsPath = Join-Path $repoRoot '.cursor\playbook-run-results.json'

$registry = Get-Content $registryPath -Raw | ConvertFrom-Json
$functional = @($registry.scenarios | Where-Object { $_.id -match '^F\d+$' -and $_.status -eq 'full' -and $_.id -notin $SkipIds })

function Discard-ScenarioTraces {
    param([string]$ScenarioId, [datetime]$Since)
    $dir = Join-Path $repoRoot ".cursor\functional-traces\$ScenarioId"
    if (-not (Test-Path $dir)) { return }
    Get-ChildItem $dir -File -ErrorAction SilentlyContinue |
        Where-Object { $_.LastWriteTime -ge $Since } |
        ForEach-Object { Remove-Item $_.FullName -Force; Write-Host "  discarded: $($_.Name)" }
}

function Invoke-FunctionalOnce {
    param([object]$Scenario, [int]$SampleIndex)
    $invokeParams = @{ Id = $Scenario.id; SampleIndex = $SampleIndex }
    if ($Scenario.vaultDefault) { $invokeParams.Vault = $Scenario.vaultDefault }
    if ($Scenario.id -eq 'F3') {
        $invokeParams.FixtureSet = 'full'
        $invokeParams.AllQueryCases = $true
    }
    $started = Get-Date
    $outFile = Join-Path $env:TEMP "seek-f-$($Scenario.id)-s$SampleIndex-$(Get-Date -Format 'yyyyMMddHHmmss').log"
    & $runScenario @invokeParams *> $outFile
    $exit = $LASTEXITCODE
    $output = Get-Content $outFile -Raw -ErrorAction SilentlyContinue
    Remove-Item $outFile -Force -ErrorAction SilentlyContinue
    return @{
        ExitCode = $exit
        Output   = $output
        Started  = $started
        Ended    = Get-Date
    }
}

$results = @()
foreach ($s in $functional) {
    $sampleRange = $FromSample..$Samples
    foreach ($sampleIdx in $sampleRange) {
        Write-Host "`n======== $($s.id) sample=$sampleIdx/$Samples ========"
        $attempt = 0
        $final = $null
        while ($attempt -le $MaxRetries) {
            $attempt++
            $started = Get-Date
            $r = Invoke-FunctionalOnce -Scenario $s -SampleIndex $sampleIdx
            $ok = ($r.ExitCode -eq 0)
            if (-not $ok) {
                Discard-ScenarioTraces -ScenarioId $s.id -Since $started
            }
            $final = $r
            if ($ok) { break }
            if ($attempt -le $MaxRetries) { Write-Host "  retry after discard" }
        }
        $durationSec = [math]::Round(($final.Ended - $final.Started).TotalSeconds, 1)
        $status = if ($final.ExitCode -eq 0) { 'pass' } else { 'fail' }
        $results += [PSCustomObject]@{
            Id     = $s.id
            Name   = $s.name
            Result = $status
            Exit   = $final.ExitCode
            Sec    = $durationSec
            Sample = $sampleIdx
        }
        Write-Host "  -> $status (${durationSec}s)"
    }
}

$results | ConvertTo-Json -Depth 6 | Set-Content -Path $resultsPath -Encoding utf8
Write-Host "`nResults -> $resultsPath"
$results | Format-Table Id, Result, Sample, Sec -AutoSize

$exportScript = Join-Path $PSScriptRoot 'export-canvas-baseline.ps1'
if (Test-Path $exportScript) {
    & $exportScript
}

if (@($results | Where-Object { $_.Result -eq 'fail' }).Count -gt 0) { exit 1 }
exit 0
