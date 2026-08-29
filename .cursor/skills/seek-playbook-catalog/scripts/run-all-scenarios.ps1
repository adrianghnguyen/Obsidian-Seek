# Run every playbook scenario serially; discard failed-run traces; append failures to markdown log.
param(
    [string]$LogPath = '',
    [switch]$IncludeColdStart,
    [int]$MaxRetries = 1,
    [int]$Samples = 3
)

$ErrorActionPreference = 'Continue'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..')).Path
$catalogRoot = Join-Path $repoRoot '.cursor\skills\seek-playbook-catalog'
$runScenario = Join-Path $PSScriptRoot 'run-scenario.ps1'
$registryPath = Join-Path $catalogRoot 'playbook-scenarios.json'

if (-not $LogPath) {
    $LogPath = Join-Path $repoRoot '.cursor\playbook-run-failures.md'
}

$registry = Get-Content $registryPath -Raw | ConvertFrom-Json
$scenarios = @($registry.scenarios)

$runId = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
$branch = (git -C $repoRoot branch --show-current 2>$null)
$sha = (git -C $repoRoot rev-parse --short HEAD 2>$null)

function Write-LogSection {
    param([string]$Text)
    Add-Content -Path $LogPath -Encoding utf8 -Value $Text
}

function Discard-ScenarioTraces {
    param([string]$ScenarioId, [datetime]$Since)
    $dirs = @(
        (Join-Path $repoRoot ".cursor\functional-traces\$ScenarioId"),
        (Join-Path $repoRoot '.cursor\gate-trace.jsonl')
    )
    foreach ($d in $dirs) {
        if (-not (Test-Path $d)) { continue }
        if (Test-Path $d -PathType Leaf) {
            if ((Get-Item $d).LastWriteTime -ge $Since) {
                Remove-Item $d -Force -ErrorAction SilentlyContinue
                Write-Host "  discarded trace file: $d"
            }
            continue
        }
        Get-ChildItem $d -File -ErrorAction SilentlyContinue |
            Where-Object { $_.LastWriteTime -ge $Since } |
            ForEach-Object {
                Remove-Item $_.FullName -Force
                Write-Host "  discarded trace: $($_.Name)"
            }
    }
}

function Invoke-ScenarioOnce {
    param(
        [object]$Scenario,
        [hashtable]$ExtraArgs = @{}
    )
    $invokeParams = @{
        Id          = $Scenario.id
        SampleIndex = 1
    }
    if ($ExtraArgs.SampleIndex) { $invokeParams.SampleIndex = [int]$ExtraArgs.SampleIndex }
    if ($Scenario.vaultDefault) { $invokeParams.Vault = $Scenario.vaultDefault }
    if ($Scenario.id -eq 'F3') {
        # seek-functional CLI name maps to plugin-sandbox-Obsidian — use full vault-polled fixture
        $fixture = 'full'
        if ($Scenario.vaultDefault -eq 'seek-functional' -or $Scenario.vaultDefault -eq 'plugin-sandbox-Obsidian') {
            $fixture = 'full'
        } elseif ($Scenario.fixtureSetDefault) {
            $fixture = $Scenario.fixtureSetDefault
        }
        $invokeParams.FixtureSet = $fixture
        $invokeParams.AllQueryCases = $true
    }
    foreach ($k in $ExtraArgs.Keys) {
        if ($ExtraArgs[$k] -is [switch] -and $ExtraArgs[$k]) { $invokeParams[$k] = $true }
        elseif ($null -ne $ExtraArgs[$k] -and $ExtraArgs[$k] -ne '') { $invokeParams[$k] = $ExtraArgs[$k] }
    }

    $started = Get-Date
    $outFile = Join-Path $env:TEMP "seek-scenario-$($Scenario.id)-$(Get-Date -Format 'yyyyMMddHHmmss').log"
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $runScenario @invokeParams *> $outFile
    } catch {
        $_ | Out-File -FilePath $outFile -Append -Encoding utf8
        $script:LastScenarioExit = 1
    }
    $exit = if ($null -ne $script:LastScenarioExit) { $script:LastScenarioExit } else { $LASTEXITCODE }
    $script:LastScenarioExit = $null
    if ($exit -eq 0 -and (Test-Path $outFile)) {
        $tail = Get-Content $outFile -Raw
        if ($tail -match 'driver stub: scenario|Write-Error|FAIL ') { $exit = 1 }
    }
    $output = Get-Content $outFile -Raw -ErrorAction SilentlyContinue
    Remove-Item $outFile -Force -ErrorAction SilentlyContinue
    $ErrorActionPreference = $prevEap

    return @{
        ExitCode = $exit
        Output   = $output
        Started  = $started
        Ended    = Get-Date
    }
}

function Reset-VaultAfterBadColdRun {
    param([string]$Vault)
    Write-Host "  reset: plugin:disable + delete IDB + restart + enable for vault=$Vault"
    & obsidian plugin:disable id=seek "vault=$Vault" 2>&1 | Out-Null
    Start-Sleep -Seconds 2
    $dbName = & obsidian eval "vault=$Vault" "code=`"(()=>{const id=app.appId||app.vault.getName();return 'seek-index:'+id})()`"" 2>&1
    $dbName = ($dbName -split "`n" | Where-Object { $_ -match 'seek-index:' }) -replace '^\s*=>\s*', '' -replace '\s', ''
    if ($dbName) {
        & obsidian eval "vault=$Vault" "code=`"new Promise((res)=>{const r=indexedDB.deleteDatabase('$dbName');r.onsuccess=()=>res('deleted');r.onerror=()=>res('error');r.onblocked=()=>res('blocked')})`"" 2>&1 | Out-Null
    }
    & obsidian restart "vault=$Vault" 2>&1 | Out-Null
    $deadline = (Get-Date).AddMinutes(3)
    do {
        Start-Sleep -Seconds 5
        $alive = & obsidian eval "vault=$Vault" "code=`"'alive'`"" 2>&1
    } while ($alive -notmatch 'alive' -and (Get-Date) -lt $deadline)
    & obsidian plugin:enable id=seek "vault=$Vault" 2>&1 | Out-Null
    Start-Sleep -Seconds 3
}

# Init log
$header = @"
# Playbook scenario run log

| Field | Value |
|-------|-------|
| Run started | $runId |
| Branch | $branch |
| Git SHA | $sha |
| Samples per full driver | $Samples |

## Summary (updated at end)

"@ 
Set-Content -Path $LogPath -Encoding utf8 -Value $header

$results = @()
$ordered = @(
    $scenarios | Where-Object { $_.status -eq 'stub' }
) + @(
    $scenarios | Where-Object { $_.status -eq 'full' -and $_.id -ne 'S1' }
)
if ($IncludeColdStart) {
    $ordered += @($scenarios | Where-Object { $_.id -eq 'S1' })
} else {
    Write-Host "Skipping S1 cold start (pass -IncludeColdStart to run ~3 min sandbox reindex)"
}

foreach ($s in $ordered) {
    $sampleRange = if ($s.status -eq 'stub') { @(1) } else { 1..$Samples }
    foreach ($sampleIdx in $sampleRange) {
        Write-Host "`n======== $($s.id) $($s.name) status=$($s.status) sample=$sampleIdx/$($sampleRange.Count) ========"
        $attempt = 0
        $final = $null
        $maxAttempts = if ($s.status -eq 'stub') { 0 } else { $MaxRetries }

        while ($attempt -le $maxAttempts) {
            $attempt++
            $started = Get-Date
            $r = Invoke-ScenarioOnce -Scenario $s -ExtraArgs @{ SampleIndex = $sampleIdx }
            $ok = ($r.ExitCode -eq 0)

            if (-not $ok) {
                Discard-ScenarioTraces -ScenarioId $s.id -Since $started
                if ($s.status -eq 'full' -and $s.id -in @('S1', 'F1') -and $attempt -le $maxAttempts) {
                    Reset-VaultAfterBadColdRun -Vault $s.vaultDefault
                }
            }

            $final = $r
            if ($ok) { break }
            if ($attempt -le $maxAttempts -and $s.status -ne 'stub') {
                Write-Host "  retry $($attempt + 1)/$($MaxRetries + 1) after discard+reset"
            }
        }

        $durationSec = [math]::Round(($final.Ended - $final.Started).TotalSeconds, 1)
        $isStubMsg = $final.Output -match 'driver stub: scenario'
        if ($s.status -eq 'stub' -or $isStubMsg) {
            $status = 'stub'
        } elseif ($final.ExitCode -eq 0) {
            $status = 'pass'
        } else {
            $status = 'fail'
        }

        $results += [PSCustomObject]@{
            Id       = $s.id
            Name     = $s.name
            Registry = $s.status
            Result   = $status
            Exit     = $final.ExitCode
            Sec      = $durationSec
            Sample   = $sampleIdx
            Output   = $final.Output
        }

        if ($status -ne 'pass') {
            if ($status -eq 'stub') { continue }
            $label = $status
            $reason = ($final.Output -split "`n" | Where-Object { $_ -match 'Error|FAIL|stub|Write-Error|Expected|invalid' } | Select-Object -First 8) -join '; '
            if (-not $reason) { $reason = ($final.Output -split "`n" | Select-Object -Last 3) -join ' ' }

            Write-LogSection @"

### $($s.id) sample $sampleIdx — $($s.name) ($label)

- **Registry status:** $($s.status)
- **Exit code:** $($final.ExitCode)
- **Duration:** ${durationSec}s
- **Vault:** $($s.vaultDefault)
- **Reason:** $reason

``````
$($final.Output.Trim())
``````

"@
        }
    }
}

$passed = @($results | Where-Object { $_.Result -eq 'pass' }).Count
$failed = @($results | Where-Object { $_.Result -eq 'fail' }).Count
$stub = @($results | Where-Object { $_.Result -eq 'stub' }).Count

$stubIds = (@($results | Where-Object { $_.Result -eq 'stub' } | ForEach-Object { $_.Id }) -join ', ')
$passDetail = (@($results | Where-Object { $_.Result -eq 'pass' } | ForEach-Object { "$($_.Id) s$($_.Sample)" }) -join '; ')

$exportPath = Join-Path $repoRoot '.cursor\playbook-run-results.json'
$results | ConvertTo-Json -Depth 6 | Set-Content -Path $exportPath -Encoding utf8
Write-Host "Exported results -> $exportPath"

$summary = @"

## Implemented drivers (pass)

$passDetail

## Stubs (not implemented, exit 1 by design)

$stubIds

| Result | Count |
|--------|-------|
| pass | $passed |
| fail | $failed |
| stub (not implemented) | $stub |
| **Total** | **$($results.Count)** |

Run finished: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')

"@
Add-Content -Path $LogPath -Encoding utf8 -Value $summary

Write-Host "`n=== DONE pass=$passed fail=$failed stub=$stub log=$LogPath ==="
$results | Format-Table Id, Name, Registry, Result, Exit, Sample, Sec -AutoSize

$exportScript = Join-Path $PSScriptRoot 'export-canvas-baseline.ps1'
if (Test-Path $exportScript) {
    Write-Host 'Exporting canvas baseline JSON...'
    & $exportScript | Out-Null
    Write-Host 'Regenerate canvas: python .cursor/skills/seek-playbook-catalog/scripts/gen-canvas-ts-block.py (see telemetry-canvas-update.mdc)'
}

if ($failed -gt 0) { exit 1 }
exit 0
