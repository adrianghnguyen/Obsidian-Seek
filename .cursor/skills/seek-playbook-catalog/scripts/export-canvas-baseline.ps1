# Build canvas baseline JSON from functional-traces + gate-trace + playbook-run-results.
param(
    [string]$OutPath = ''
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..')).Path
$traceRoot = Join-Path $repoRoot '.cursor\functional-traces'
$catalogRoot = Split-Path $PSScriptRoot -Parent
if (-not $OutPath) { $OutPath = Join-Path $repoRoot '.cursor\canvas-baseline-export.json' }

$sha = (git -C $repoRoot rev-parse --short HEAD 2>$null)
$branch = (git -C $repoRoot branch --show-current 2>$null)

$defaultFixtureByScenario = @{
    S1 = 'plugin-sandbox'
    S2 = 'g2-fresh-id'
    S3 = 'dev-vault'
    S4 = 'g2-fresh-id'
    S5 = 'plugin-sandbox'
    S6 = 'seek-functional'
    S7 = 'seek-functional'
    F1 = 'plugin-sandbox'
    F2 = 'seek-functional'
    F3 = 'full'
    F4 = 'seek-functional'
    F5 = 'seek-functional'
    F6 = 'seek-functional'
    F7 = 'seek-functional'
    F8 = 'plugin-sandbox'
    F9 = 'seek-functional'
    F10 = 'seek-functional'
}

function SampleFromFilename {
    param([string]$Name)
    if ($Name -match 'sample(\d+)') { return [int]$Matches[1] }
    return 1
}

function FixtureFromTrace {
    param(
        [string]$ScenarioId,
        [string]$FileName,
        [object]$TraceObj
    )
    if ($TraceObj -and $TraceObj.PSObject.Properties.Name -contains 'fixture' -and $TraceObj.fixture) {
        return [string]$TraceObj.fixture
    }
    if ($FileName -match 'F3-(minimal|full)-') { return $Matches[1] }
    if ($FileName -match '-(minimal|full)-sample') { return $Matches[1] }
    return $defaultFixtureByScenario[$ScenarioId]
}

function Ensure-ChartSpec {
    param(
        [string]$ScenarioId,
        [string]$Unit,
        [string]$Metric
    )
    if (-not $script:chartByScenario.ContainsKey($ScenarioId)) {
        $script:chartByScenario[$ScenarioId] = @{
            unit    = $Unit
            metric  = $Metric
            points  = @()
        }
    }
}

function Add-AtomicPoint {
    param(
        [string]$ScenarioId,
        [string]$Unit,
        [string]$Metric,
        [double]$Value,
        [int]$SampleIndex,
        [string]$Fixture,
        [string]$QueryCase = ''
    )
    Ensure-ChartSpec -ScenarioId $ScenarioId -Unit $Unit -Metric $Metric
    $point = @{
        value       = $Value
        sampleIndex = $SampleIndex
        fixture     = $Fixture
    }
    if ($QueryCase) { $point['queryCase'] = $QueryCase }
    $script:chartByScenario[$ScenarioId].points += $point
}

$chartByScenario = @{}
$runs = @()

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
    $traceDir = Join-Path $traceRoot $sid
    if (-not (Test-Path $traceDir)) { continue }
    $bySample = @{}
    foreach ($f in (Get-ChildItem $traceDir -File -Filter '*.json' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending)) {
        $si = SampleFromFilename $f.Name
        if ($bySample.ContainsKey($si)) { continue }
        $bySample[$si] = $f
    }
    foreach ($si in ($bySample.Keys | Sort-Object)) {
        $f = $bySample[$si]
        $t = Get-Content $f.FullName -Raw | ConvertFrom-Json
        $map = $genericMap[$sid]
        $metricKey = $map.key
        $fixture = FixtureFromTrace -ScenarioId $sid -FileName $f.Name -TraceObj $t
        $val = $null
        if ($t.PSObject.Properties.Name -contains $metricKey) { $val = [double]$t.$metricKey }
        $run = @{
            id          = "$($sid.ToLower())-sample$si-$($f.Name)"
            scenarioId  = $sid
            sampleIndex = $si
            fixture     = $fixture
            outcome     = if ($t.pass -eq $false) { 'fail' } else { 'success' }
            gitSha      = $sha
            artifacts   = @{ jsonlPath = ".cursor/functional-traces/$sid/$($f.Name)" }
        }
        if ($null -ne $val) {
            $run.metrics = @{ $map.metric = $val }
            Add-AtomicPoint -ScenarioId $sid -Unit $map.unit -Metric $map.metric -Value $val -SampleIndex $si -Fixture $fixture
        }
        if ($t.probeSec) { $run.durationSec = [double]$t.probeSec }
        $runs += $run
    }
}

# S6 — latest trace file per sample
$s6BySample = @{}
foreach ($f in (Get-ChildItem (Join-Path $traceRoot 'S6') -File -Filter '*.json' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending)) {
    $si = SampleFromFilename $f.Name
    if ($s6BySample.ContainsKey($si)) { continue }
    $s6BySample[$si] = $f
}
foreach ($si in ($s6BySample.Keys | Sort-Object)) {
    $f = $s6BySample[$si]
    $t = Get-Content $f.FullName -Raw | ConvertFrom-Json
    $fixture = FixtureFromTrace -ScenarioId 'S6' -FileName $f.Name -TraceObj $t
    $partialMs = if ($null -ne $t.namePartialMs) { [double]$t.namePartialMs } elseif ($null -ne $t.partialMs) { [double]$t.partialMs } else { $null }
    if ($null -ne $partialMs) {
        Add-AtomicPoint -ScenarioId 'S6' -Unit 'namePartialMs (ms)' -Metric 'namePartialMs' -Value $partialMs -SampleIndex $si -Fixture $fixture
    }
    $runs += @{
        id          = "s6-sample$si-$($f.Name)"
        scenarioId  = 'S6'
        sampleIndex = $si
        fixture     = $fixture
        outcome     = 'success'
        gitSha      = $sha
        metrics     = @{
            namePartialMs = $partialMs
            queryEmbedMs  = $t.queryEmbedMs
            T_search_ms   = $t.elapsedMs
        }
        artifacts   = @{ jsonlPath = ".cursor/functional-traces/S6/$($f.Name)" }
    }
}

# F3 — latest jsonl per sample; one atomic point per query case
$f3BySample = @{}
foreach ($f in (Get-ChildItem (Join-Path $traceRoot 'F3') -File -Filter '*.jsonl' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending)) {
    $si = SampleFromFilename $f.Name
    if ($f3BySample.ContainsKey($si)) { continue }
    $fixture = FixtureFromTrace -ScenarioId 'F3' -FileName $f.Name -TraceObj $null
    $latencies = @()
    foreach ($line in Get-Content $f.FullName -Encoding UTF8) {
        if (-not $line.Trim()) { continue }
        try {
            $o = $line | ConvertFrom-Json
            if ($null -eq $o.elapsedMs) { continue }
            $caseId = if ($o.caseId) { [string]$o.caseId } else { '' }
            Add-AtomicPoint -ScenarioId 'F3' -Unit 'seek:search latency (ms)' -Metric 'T_search_ms' -Value ([double]$o.elapsedMs) -SampleIndex $si -Fixture $fixture -QueryCase $caseId
            $latencies += [double]$o.elapsedMs
        } catch { }
    }
    if ($latencies.Count -eq 0) { continue }
    $f3BySample[$si] = @{ file = $f.Name; latencies = $latencies; fixture = $fixture }
    $runs += @{
        id          = "f3-sample$si-$($f3BySample[$si].file)"
        scenarioId  = 'F3'
        sampleIndex = $si
        fixture     = $fixture
        outcome     = 'success'
        gitSha      = $sha
        metrics     = @{ T_search_ms = [math]::Round(($latencies | Measure-Object -Average).Average, 0) }
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
        $sid = $r.Id
        $si = [int]$r.Sample
        $fixture = $defaultFixtureByScenario[$sid]
        $metricMs = [math]::Round($r.Sec * 1000, 0)
        $key = if ($sid -eq 'F2') { 'T_first_good_ms' } else { 'T_start_ms' }
        $unit = if ($sid -eq 'F2') { 'Time to first ok search (ms)' } else { 'Gate release T_start (ms)' }
        Add-AtomicPoint -ScenarioId $sid -Unit $unit -Metric $key -Value $metricMs -SampleIndex $si -Fixture $fixture
        $runs += @{
            id          = "$($sid.ToLower())-sample$si-batch"
            scenarioId  = $sid
            sampleIndex = $si
            fixture     = $fixture
            outcome     = 'success'
            gitSha      = $sha
            durationSec = $r.Sec
            metrics     = @{ $key = $metricMs }
        }
    }
}

$registryPath = Join-Path $catalogRoot 'playbook-scenarios.json'
$registry = Get-Content $registryPath -Raw | ConvertFrom-Json
$registryStubIds = @($registry.scenarios | Where-Object { $_.status -eq 'stub' } | ForEach-Object { $_.id })

$withRuns = @($runs | ForEach-Object { $_.scenarioId } | Select-Object -Unique)
$stubScenarioIds = @($registryStubIds | Where-Object { $_ -notin $withRuns })

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
