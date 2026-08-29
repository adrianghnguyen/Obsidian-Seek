# Build canvas baseline JSON from functional-traces + latest playbook-run-results.
param(
    [string]$OutPath = ''
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..')).Path
$traceRoot = Join-Path $repoRoot '.cursor\functional-traces'
if (-not $OutPath) { $OutPath = Join-Path $repoRoot '.cursor\canvas-baseline-export.json' }

$sha = (git -C $repoRoot rev-parse --short HEAD 2>$null)
$branch = (git -C $repoRoot branch --show-current 2>$null)

function Get-LatestTraces {
    param([string]$ScenarioId, [string]$Pattern = '*')
    $dir = Join-Path $traceRoot $ScenarioId
    if (-not (Test-Path $dir)) { return @() }
    Get-ChildItem $dir -File -Filter $Pattern |
        Sort-Object LastWriteTime -Descending
}

function Parse-F3Trace {
    param([string]$Path)
    $ms = @()
    foreach ($line in Get-Content $Path -Encoding UTF8 -ErrorAction SilentlyContinue) {
        if (-not $line.Trim()) { continue }
        try {
            $o = $line | ConvertFrom-Json
            if ($null -ne $o.elapsedMs) { $ms += [double]$o.elapsedMs }
        } catch { }
    }
    return $ms
}

function Parse-S6Trace {
    param([string]$Path)
    try {
        return Get-Content $Path -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {
        return $null
    }
}

function SampleFromFilename {
    param([string]$Name)
    if ($Name -match 'sample(\d+)') { return [int]$Matches[1] }
    return 1
}

$violinByScenario = @{}
$runs = @()

# S6 — group by sample, latest trace per sample
$s6BySample = @{}
foreach ($f in (Get-LatestTraces 'S6' '*.json')) {
    $si = SampleFromFilename $f.Name
    if ($s6BySample.ContainsKey($si)) { continue }
    $t = Parse-S6Trace $f.FullName
    if (-not $t) { continue }
    $s6BySample[$si] = @{ file = $f.Name; trace = $t }
}
$s6Partial = @()
$s6Embed = @()
$s6Total = @()
foreach ($si in ($s6BySample.Keys | Sort-Object)) {
    $t = $s6BySample[$si].trace
    $ok = $t.partialFired -eq $true -and $t.nameEarlyPainted -eq $true
    if ($t.namePartialMs) { $s6Partial += [double]$t.namePartialMs }
    if ($t.queryEmbedMs) { $s6Embed += [double]$t.queryEmbedMs }
    if ($t.elapsedMs) { $s6Total += [double]$t.elapsedMs }
    $runs += @{
        id          = "s6-sample$si-$($s6BySample[$si].file)"
        scenarioId  = 'S6'
        sampleIndex = $si
        outcome     = if ($ok) { 'success' } else { 'fail' }
        gitSha      = $sha
        metrics     = @{
            namePartialMs = $t.namePartialMs
            queryEmbedMs  = $t.queryEmbedMs
            T_search_ms   = $t.elapsedMs
        }
        artifacts   = @{ jsonlPath = ".cursor/functional-traces/S6/$($s6BySample[$si].file)" }
    }
}
if ($s6Partial.Count -ge 1) {
    $violinByScenario['S6'] = @{
        unit   = 'namePartialMs (ms)'
        metric = 'namePartialMs'
        series = @(
            @{ label = 'partial'; values = $s6Partial }
        )
    }
}

# F3 — latest trace per sample index
$f3BySample = @{}
foreach ($f in (Get-LatestTraces 'F3' '*.jsonl')) {
    $si = SampleFromFilename $f.Name
    if ($f3BySample.ContainsKey($si)) { continue }
    $ms = Parse-F3Trace $f.FullName
    if ($ms.Count -eq 0) { continue }
    $f3BySample[$si] = @{ file = $f.Name; latencies = $ms }
}
$f3Series = @()
foreach ($si in ($f3BySample.Keys | Sort-Object)) {
    $lat = $f3BySample[$si].latencies
    $f3Series += @{ label = "sample $si"; values = $lat }
    $p50 = ($lat | Sort-Object)[[math]::Floor($lat.Count * 0.5)]
    $runs += @{
        id          = "f3-sample$si-$($f3BySample[$si].file)"
        scenarioId  = 'F3'
        sampleIndex = $si
        outcome     = 'success'
        gitSha      = $sha
        metrics     = @{ T_search_ms = [math]::Round(($lat | Measure-Object -Average).Average, 0); p50_ms = $p50 }
        artifacts   = @{ jsonlPath = ".cursor/functional-traces/F3/$($f3BySample[$si].file)" }
    }
}
if ($f3Series.Count -ge 1) {
    $violinByScenario['F3'] = @{
        unit   = 'seek:search latency (ms)'
        metric = 'T_search_ms'
        series = $f3Series
    }
}

# F2 / S1 — parse driver output lines from playbook-run-results if present
$resultsPath = Join-Path $repoRoot '.cursor\playbook-run-results.json'
if (Test-Path $resultsPath) {
    $batch = Get-Content $resultsPath -Raw | ConvertFrom-Json
    foreach ($r in @($batch)) {
        if ($r.Id -notin @('F2', 'S1')) { continue }
        if ($r.Result -ne 'pass') { continue }
        $metricMs = [math]::Round($r.Sec * 1000, 0)
        $key = if ($r.Id -eq 'F2') { 'T_first_good_ms' } else { 'T_start_ms' }
        if (-not $violinByScenario.ContainsKey($r.Id)) {
            $violinByScenario[$r.Id] = @{
                unit   = if ($r.Id -eq 'F2') { 'first good search (ms)' } else { 'gate release (ms)' }
                metric = $key
                series = @(@{ label = $r.Id; values = @() })
            }
        }
        $violinByScenario[$r.Id].series[0].values += $metricMs
        $runs += @{
            id          = "$($r.Id.ToLower())-sample$($r.Sample)-batch"
            scenarioId  = $r.Id
            sampleIndex = $r.Sample
            outcome     = 'success'
            gitSha      = $sha
            durationSec = $r.Sec
            metrics     = @{ $key = $metricMs }
        }
    }
}

$export = @{
    exportedAt       = (Get-Date).ToString('o')
    branch           = $branch
    gitSha           = $sha
    violinByScenario = $violinByScenario
    runs             = $runs
    stubScenarioIds  = @('S2', 'S3', 'S4', 'S5', 'S7', 'F1', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10')
}

$export | ConvertTo-Json -Depth 10 | Set-Content -Path $OutPath -Encoding utf8
Write-Host "Canvas export -> $OutPath ($($runs.Count) runs, $($violinByScenario.Keys.Count) violin scenarios)"
