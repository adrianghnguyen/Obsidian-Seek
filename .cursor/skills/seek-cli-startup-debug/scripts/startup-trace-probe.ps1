# Startup trace probe — Run A (cold-restart) or Run B (warm-reload).
# Emits gate-trace.jsonl for parse-startup-trace.mjs.
# Usage:
#   .\startup-trace-probe.ps1 -Run A -PathId baseline
#   .\startup-trace-probe.ps1 -Run B -PathId baseline

param(
    [ValidateSet('A', 'B')]
    [string]$Run = 'A',
    [string]$Vault = 'Obsidian',
    [string]$PathId = 'baseline',
    [int]$MaxSeconds = 120,
    [string]$JsonlFile = ''
)

$ErrorActionPreference = 'Continue'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..')).Path
if (-not $JsonlFile) { $JsonlFile = Join-Path $repoRoot '.cursor\gate-trace.jsonl' }
$runLabel = if ($Run -eq 'A') { 'cold-restart' } else { 'warm-reload' }
$gitSha = ''
Push-Location $repoRoot
try { $gitSha = (git rev-parse --short HEAD 2>$null) } catch { $gitSha = 'unknown' }
finally { Pop-Location }

function Write-Jsonl([hashtable]$Obj) {
    $line = ($Obj | ConvertTo-Json -Compress -Depth 8)
    Add-Content -Path $JsonlFile -Value $line
    return $line
}

function Run-Obsidian {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Args)
    return (& obsidian @Args 2>&1 | Out-String).Trim()
}

function Parse-Eval([string]$Out) {
    ($Out -split "`n" | Where-Object { $_ -match '^\s*=>\s*' } | ForEach-Object { $_ -replace '^\s*=>\s*', '' }) -join ''
}

function Get-Elapsed([datetime]$Start) {
    [math]::Round(((Get-Date) - $Start).TotalSeconds, 2)
}

$gateCode = @'
(()=>{const s=app.plugins.plugins.seek;if(!s)return JSON.stringify({seek:false});const j=s.getIndexJob();return s.getIndexStats().then(st=>JSON.stringify({ver:s.manifest.version,warmPhase:s.indexWarmPhase,warmingUp:s.isIndexWarmingUp,uiHealth:s.indexUiHealth,indexHealth:s.indexHealthState,sidecarHydrating:!!s.sidecarHydrating,bootPending:!!s.indexBootPending,goodEnough:!!s.isIndexGoodEnough,isIndexing:s.isIndexing,catchUpRunning:!!s.catchUpRunning,job:j?{done:j.done,total:j.total,remaining:Math.max(0,j.total-j.done)}:null,files:st.files,chunks:st.chunks}))})()
'@ -replace "`r`n|`n", ''

$precheckCode = @'
(()=>{const s=app.plugins.plugins.seek;if(!s)return JSON.stringify({ok:false,reason:"no-seek"});const j=s.getIndexJob();const rem=j?Math.max(0,j.total-j.done):0;return s.getIndexStats().then(st=>JSON.stringify({ok:s.indexUiHealth==="ok"&&s.indexWarmPhase===null&&rem===0,uiHealth:s.indexUiHealth,warmPhase:s.indexWarmPhase,remaining:rem,chunks:st.chunks}))})()
'@ -replace "`r`n|`n", ''

Write-Host "=== startup-trace-probe run=$runLabel path=$PathId vault=$Vault sha=$gitSha ==="
if (Test-Path $JsonlFile) { Remove-Item $JsonlFile -Force }

$start = Get-Date
$didHydrateSearch = $false
$firstOkAt = $null

if ($Run -eq 'B') {
    Write-Host 'Run B precheck (idle required)...'
    $pre = Parse-Eval (Run-Obsidian eval "vault=$Vault" "code=$precheckCode")
    Write-Jsonl @{
        ts      = (Get-Date).ToString('o')
        elapsed_s = 0
        run     = $runLabel
        path_id = $PathId
        git_sha = $gitSha
        event   = 'precheck'
        precheck = ($pre | ConvertFrom-Json -ErrorAction SilentlyContinue)
    } | Out-Null
    if ($pre -notmatch 'ok.:true') {
        Write-Host "WARN: vault not idle - precheck=$pre"
    }
    Run-Obsidian dev:console clear "vault=$Vault" | Out-Null
    Run-Obsidian dev:errors clear "vault=$Vault" | Out-Null
    Write-Host 'plugin:reload'
    Run-Obsidian plugin:reload id=seek "vault=$Vault" | Out-Null
    Start-Sleep -Seconds 2
    Run-Obsidian dev:debug on "vault=$Vault" | Out-Null
} else {
    Write-Host 'Run A restart'
    Run-Obsidian restart "vault=$Vault" | Out-Null
    $alive = ''
    do {
        Start-Sleep -Seconds 1
        $alive = Parse-Eval (Run-Obsidian eval "vault=$Vault" 'code=JSON.stringify({alive:true,seek:!!app.plugins.plugins.seek})')
        $elapsed = Get-Elapsed $start
        Write-Host "  ${elapsed}s alive=$alive"
    } while ($elapsed -lt 30 -and ($alive -notmatch '"seek":true'))
    Run-Obsidian dev:debug on "vault=$Vault" | Out-Null
}

while ((Get-Elapsed $start) -lt $MaxSeconds) {
    $elapsed = Get-Elapsed $start
    $gateRaw = Run-Obsidian eval "vault=$Vault" "code=$gateCode"
    $gateStr = Parse-Eval $gateRaw
    $gateObj = $null
    try { $gateObj = $gateStr | ConvertFrom-Json } catch { $gateObj = @{ raw = $gateStr } }

    $searchSnippet = $null
    $isStarting = $gateStr -match '"warmPhase":"(starting|restoring)"' -or $gateStr -match '"uiHealth":"(starting|restoring)"' -or $gateStr -match '"sidecarHydrating":true'
    $isOk = $gateStr -match '"uiHealth":"ok"' -and $gateStr -notmatch '"warmPhase":"(starting|restoring)"'

    if ($Run -eq 'A' -and $isStarting -and -not $didHydrateSearch) {
        $searchOut = Run-Obsidian seek:search query=probe limit=1 "vault=$Vault"
        $searchSnippet = ($searchOut -split "`n" | Select-Object -First 4) -join ' / '
        $didHydrateSearch = $true
        Write-Jsonl @{
            ts         = (Get-Date).ToString('o')
            elapsed_s  = $elapsed
            run        = $runLabel
            path_id    = $PathId
            git_sha    = $gitSha
            event      = 'gate-test'
            gate       = $gateObj
            search     = $searchSnippet
        } | Out-Null
    }

    if ($Run -eq 'B' -and $isOk -and -not $firstOkAt) {
        $searchOut = Run-Obsidian seek:search query=probe limit=1 "vault=$Vault"
        $searchSnippet = ($searchOut -split "`n" | Select-Object -First 4) -join ' / '
        $firstOkAt = $elapsed
        Write-Jsonl @{
            ts         = (Get-Date).ToString('o')
            elapsed_s  = $elapsed
            run        = $runLabel
            path_id    = $PathId
            git_sha    = $gitSha
            event      = 'first-search'
            gate       = $gateObj
            search     = $searchSnippet
        } | Out-Null
    }

    Write-Jsonl @{
        ts        = (Get-Date).ToString('o')
        elapsed_s = $elapsed
        run       = $runLabel
        path_id   = $PathId
        git_sha   = $gitSha
        event     = 'poll'
        gate      = $gateObj
    } | Out-Null

    Write-Host "--- ${elapsed}s warmPhase=$($gateObj.warmPhase) uiHealth=$($gateObj.uiHealth) ---"

    if ($Run -eq 'A' -and $elapsed -gt 1) {
        $gateReleased = ($gateStr -match '"warmPhase":null' -and $gateStr -notmatch '"bootPending":true') -or ($gateStr -match '"goodEnough":true')
        if ($gateReleased) {
            Write-Host 'Run A: gate released - stopping'
            break
        }
    }
    if ($Run -eq 'B' -and $isOk) {
        $rem = 0
        if ($gateObj.job) { $rem = $gateObj.job.remaining }
        if ($rem -eq 0 -and $elapsed -gt 5) {
            Write-Host 'Run B: idle ok — stopping'
            break
        }
    }

    Start-Sleep -Seconds 2
}

Write-Host 'Generating logging report...'
Run-Obsidian eval "vault=$Vault" 'code=app.plugins.plugins.seek.openLoggingReport().then(()=>"ok")' | Out-Null

$dateTag = Get-Date -Format 'yyyyMMdd-HHmmss'
$scoreDir = Join-Path $repoRoot '.cursor\scorecards'
if (-not (Test-Path $scoreDir)) { New-Item -ItemType Directory -Path $scoreDir | Out-Null }
$reportSrc = Join-Path "C:\Obsidian" '.seek-artifacts\seek-report.json'
if (Test-Path $reportSrc) {
    $dest = Join-Path $scoreDir "$PathId-$runLabel-$dateTag.json"
    Copy-Item $reportSrc $dest -Force
    Write-Host "Copied report -> $dest"
}

Write-Host "JSONL -> $JsonlFile"
Write-Host '=== done ==='
