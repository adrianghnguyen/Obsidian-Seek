# Build canvas baseline JSON from functional-traces + gate-trace + playbook-run-results.
param(
    [string]$OutPath = ''
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..')).Path
$traceRoot = Join-Path $repoRoot '.cursor\functional-traces'
if (-not $OutPath) { $OutPath = Join-Path $repoRoot '.cursor\canvas-baseline-export.json' }

$sha = (git -C $repoRoot rev-parse --short HEAD 2>$null)
$branch = (git -C $repoRoot branch --show-current 2>$null)

function SampleFromFilename {
    param([string]$Name)
    if ($Name -match 'sample(\d+)') { return [int]$Matches[1] }
    return 1
}

function Get-LatestTraceFile {
    param([string]$ScenarioId, [string]$Pattern = '*')
    $dir = Join-Path $traceRoot $ScenarioId
    if (-not (Test-Path $dir)) { return $null }
    Get-ChildItem $dir -File -Filter $Pattern | Sort-Object LastWriteTime -Descending | Select-Object -First 1
}

$chartByScenario = @{}
$runs = @()

function Add-Run {
    param([hashtable]$Run)
    $runs += $Run
}

function Add-ChartPoint {
    param(
        [string]$ScenarioId,
        [string]$Unit,
        [string]$Metric,
        [string]$Label,
        [double]$Value
    )
    if (-not $chartByScenario.ContainsKey($ScenarioId)) {
        $chartByScenario[$ScenarioId] = @{
            unit   = $Unit
            metric = $Metric
            series = @()
        }
    }
    $series = @($chartByScenario[$ScenarioId].series)
    $existing = $series | Where-Object { $_.label -eq $Label } | Select-Object -First 1
    if ($existing) {
        $existing.values += $Value
    } else {
        $series += @{ label = $Label; values = @($Value) }
    }
    $chartByScenario[$ScenarioId].series = $series
}

# Generic JSON trace scenarios
$genericMap = @{
    S2 = @{ metric = 'durationSec'; unit = 'incremental probe (s)'; key = 'probeSec' }
    S3 = @{ metric = 'T_first_good_ms'; unit = 'Time to first good search (ms)'; key = 'T_first_good_ms' }
    S4 = @{ metric = 'files_walked'; unit = 'files walked on hydrate'; key = 'filesWalked' }
    S5 = @{ metric = 'T_search_ms'; unit = 'needle search latency (ms)'; key = 'elapsedMs' }
    S7 = @{ metric = 'T_search_ms'; unit = 'supersession probe (ms)'; key = 'elapsedMs' }
    F1 = @{ metric = 'T_first_good_ms'; unit = 'cold boot search (ms)'; key = 'searchMs' }
    F4 = @{ metric = 'T_search_ms'; unit = 'seek:open latency (ms)'; key = 'elapsedMs' }
    F5 = @{ metric = 'T_search_ms'; unit = 'insert-link latency (ms)'; key = 'elapsedMs' }
    F6 = @{ metric = 'T_search_ms'; unit = 'modal search latency (ms)'; key = 'elapsedMs' }
    F7 = @{ metric = 'T_search_ms'; unit = 'modal insert latency (ms)'; key = 'elapsedMs' }
    F8 = @{ metric = 'T_search_ms'; unit = 'catch-up search (ms)'; key = 'searchMs' }
    F9 = @{ metric = 'namePartialMs'; unit = 'modal early paint (ms)'; key = 'partialMs' }
    F10 = @{ metric = 'T_search_ms'; unit = 'rapid cancel probe (ms)'; key = 'elapsedMs' }
}

foreach ($sid in $genericMap.Keys) {
    $f = Get-LatestTraceFile $sid '*.json'
    if (-not $f) { continue }
    $t = Get-Content $f.FullName -Raw | ConvertFrom-Json
    $map = $genericMap[$sid]
    $metricKey = $map.key
    $val = $null
    if ($t.PSObject.Properties.Name -contains $metricKey) { $val = [double]$t.$metricKey }
    $si = SampleFromFilename $f.Name
    $run = @{
        id          = "$($sid.ToLower())-sample$si-$($f.Name)"
        scenarioId  = $sid
        sampleIndex = $si
        outcome     = if ($t.pass -eq $false) { 'fail' } else { 'success' }
        gitSha      = $sha
        artifacts   = @{ jsonlPath = ".cursor/functional-traces/$sid/$($f.Name)" }
    }
    if ($null -ne $val) {
        $run.metrics = @{ $map.metric = $val }
        Add-ChartPoint -ScenarioId $sid -Unit $map.unit -Metric $map.metric -Label "Sample $si" -Value $val
    }
    if ($t.probeSec) { $run.durationSec = [double]$t.probeSec }
    $runs += $run
}

# S6 — latest per sample
$s6BySample = @{}
foreach ($f in (Get-ChildItem (Join-Path $traceRoot 'S6') -File -Filter '*.json' -ErrorAction SilentlyContinue)) {
    $si = SampleFromFilename $f.Name
    if ($s6BySample.ContainsKey($si)) { continue }
    $s6BySample[$si] = $f
}
foreach ($si in ($s6BySample.Keys | Sort-Object)) {
    $f = $s6BySample[$si]
    $t = Get-Content $f.FullName -Raw | ConvertFrom-Json
    if ($t.namePartialMs) {
        Add-ChartPoint -ScenarioId 'S6' -Unit 'namePartialMs (ms)' -Metric 'namePartialMs' -Label "Sample $si" -Value ([double]$t.namePartialMs)
    }
    $runs += @{
        id          = "s6-sample$si-$($f.Name)"
        scenarioId  = 'S6'
        sampleIndex = $si
        outcome     = 'success'
        gitSha      = $sha
        metrics     = @{
            namePartialMs = $t.namePartialMs
            queryEmbedMs  = $t.queryEmbedMs
            T_search_ms   = $t.elapsedMs
        }
        artifacts   = @{ jsonlPath = ".cursor/functional-traces/S6/$($f.Name)" }
    }
}

# F3 — latest jsonl per sample
$f3BySample = @{}
foreach ($f in (Get-ChildItem (Join-Path $traceRoot 'F3') -File -Filter '*.jsonl' -ErrorAction SilentlyContinue)) {
    $si = SampleFromFilename $f.Name
    if ($f3BySample.ContainsKey($si)) { continue }
    $ms = @()
    foreach ($line in Get-Content $f.FullName -Encoding UTF8) {
        if (-not $line.Trim()) { continue }
        try {
            $o = $line | ConvertFrom-Json
            if ($null -ne $o.elapsedMs) { $ms += [double]$o.elapsedMs }
        } catch { }
    }
    if ($ms.Count -eq 0) { continue }
    $f3BySample[$si] = @{ file = $f.Name; latencies = $ms }
    foreach ($v in $ms) {
        Add-ChartPoint -ScenarioId 'F3' -Unit 'seek:search latency (ms)' -Metric 'T_search_ms' -Label "Sample $si" -Value $v
    }
    $lat = $f3BySample[$si].latencies
    $runs += @{
        id          = "f3-sample$si-$($f3BySample[$si].file)"
        scenarioId  = 'F3'
        sampleIndex = $si
        outcome     = 'success'
        gitSha      = $sha
        metrics     = @{ T_search_ms = [math]::Round(($lat | Measure-Object -Average).Average, 0) }
        artifacts   = @{ jsonlPath = ".cursor/functional-traces/F3/$($f3BySample[$si].file)" }
    }
}

# F2 / S1 from playbook-run-results if present
$resultsPath = Join-Path $repoRoot '.cursor\playbook-run-results.json'
if (Test-Path $resultsPath) {
    $batch = Get-Content $resultsPath -Raw | ConvertFrom-Json
    foreach ($r in @($batch)) {
        if ($r.Id -notin @('F2', 'S1')) { continue }
        if ($r.Result -ne 'pass') { continue }
        $metricMs = [math]::Round($r.Sec * 1000, 0)
        $key = if ($r.Id -eq 'F2') { 'T_first_good_ms' } else { 'T_start_ms' }
        $unit = if ($r.Id -eq 'F2') { 'Time to first ok search (ms)' } else { 'Gate release T_start (ms)' }
        Add-ChartPoint -ScenarioId $r.Id -Unit $unit -Metric $key -Label "Sample $($r.Sample)" -Value $metricMs
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

# Fallback S1/F2 from gate-trace if no batch results
foreach ($sid in @('S1', 'F2')) {
    if (@($runs | Where-Object { $_.scenarioId -eq $sid }).Count -gt 0) { continue }
    $f = Get-LatestTraceFile $sid '*.json'
    if ($f) { continue }
    $gatePath = Join-Path $repoRoot '.cursor\gate-trace.jsonl'
    if (-not (Test-Path $gatePath)) { continue }
    $lines = Get-Content $gatePath -Encoding UTF8 | Where-Object { $_ -match "`"$([regex]::Escape($sid))" }
    if ($lines.Count -eq 0) { continue }
}

$allScenarioIds = @('S1','S2','S3','S4','S5','S6','S7','F1','F2','F3','F4','F5','F6','F7','F8','F9','F10')
$withRuns = @($runs | ForEach-Object { $_.scenarioId } | Select-Object -Unique)
$stubScenarioIds = @($allScenarioIds | Where-Object { $_ -notin $withRuns })

$export = @{
    exportedAt       = (Get-Date).ToString('o')
    branch           = $branch
    gitSha           = $sha
    chartByScenario  = $chartByScenario
    runs             = $runs
    stubScenarioIds  = $stubScenarioIds
}

$export | ConvertTo-Json -Depth 10 | Set-Content -Path $OutPath -Encoding utf8
Write-Host "Canvas export -> $OutPath ($($runs.Count) runs, $($chartByScenario.Keys.Count) chart scenarios, $($stubScenarioIds.Count) stubs)"
