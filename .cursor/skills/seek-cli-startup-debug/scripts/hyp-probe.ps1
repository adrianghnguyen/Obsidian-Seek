# Hypothesis probe: serial restart + gates + status-bar DOM. No seek:search while Indexing.
param(
    [string]$Vault = "plugin-sandbox-Obsidian",
    [int]$MaxSeconds = 90,
    [string]$LogFile = ""
)

$ErrorActionPreference = "Continue"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..\..")).Path
if (-not $LogFile) { $LogFile = Join-Path $repoRoot ".cursor\seek-hyp-run.log" }

function Log([string]$Msg) {
    $line = "[$(Get-Date -Format 'HH:mm:ss')] $Msg"
    Write-Host $line
    Add-Content -Path $LogFile -Value $line
}

function Run-Obsidian {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Args)
    $out = & obsidian @Args 2>&1
    $out | ForEach-Object { Add-Content -Path $LogFile -Value $_ }
    return ($out | Out-String).Trim()
}

function Parse-Eval([string]$Out) {
    ($Out -split "`n" | Where-Object { $_ -match '^\s*=>\s*' } | ForEach-Object { $_ -replace '^\s*=>\s*', '' }) -join ''
}

function Get-Elapsed([datetime]$Start) {
    [math]::Round(((Get-Date) - $Start).TotalSeconds, 1)
}

if (Test-Path $LogFile) { Remove-Item $LogFile -Force }

Log "=== Seek hypothesis probe (vault=$Vault, max=${MaxSeconds}s) ==="
Log "Restarting Obsidian (skip console clear; debug does not survive restart)"
Run-Obsidian restart "vault=$Vault" | Out-Null

$start = Get-Date
Log "Polling until alive..."
$alive = ""
do {
    Start-Sleep -Seconds 1
    $aliveOut = Run-Obsidian eval "vault=$Vault" 'code=JSON.stringify({alive:true,seek:!!app.plugins.plugins.seek})'
    $alive = Parse-Eval $aliveOut
    $elapsed = Get-Elapsed $start
    Log "  ${elapsed}s alive=$alive"
} while ($elapsed -lt 30 -and ($alive -notmatch '"seek":true'))

Log "Reattaching debugger"
Run-Obsidian dev:debug on "vault=$Vault" | Out-Null

$gateCode = @'
(()=>{const s=app.plugins.plugins.seek;if(!s)return JSON.stringify({seek:false});const j=s.getIndexJob();return s.getIndexStats().then(st=>JSON.stringify({ver:s.manifest.version,warmPhase:s.indexWarmPhase,warmingUp:s.isIndexWarmingUp,uiHealth:s.indexUiHealth,catchUpRunning:!!s.catchUpRunning,sidecarHydrating:!!s.sidecarHydrating,bootPending:!!s.indexBootPending,isIndexing:s.isIndexing,job:j?{done:j.done,total:j.total,remaining:Math.max(0,j.total-j.done)}:null,files:st.files,chunks:st.chunks}))})()
'@ -replace "`r`n|`n", ""

$didHydrateSearch = $false

while ((Get-Elapsed $start) -lt $MaxSeconds) {
    $elapsed = Get-Elapsed $start
    $gateRaw = Run-Obsidian eval "vault=$Vault" "code=$gateCode"
    $gate = Parse-Eval $gateRaw
    Log "--- ${elapsed}s gate=$gate"

    $dom = Run-Obsidian dev:dom selector=".plugin-seek.seek-status-bar" text "vault=$Vault"
    $domOne = (($dom -split "`n" | Select-Object -First 8) -join " / ")
    Log "  statusbar=$domOne"

    $isStarting = $gate -match '"warmPhase":"(starting|restoring)"' -or $gate -match '"uiHealth":"(starting|restoring)"' -or $gate -match '"sidecarHydrating":true'
    $isOk = $gate -match '"uiHealth":"ok"' -and $gate -notmatch '"warmPhase":"(starting|restoring)"'

    if ($isStarting -and -not $didHydrateSearch) {
        Log "  seek:search (hydrate window only)"
        $search = Run-Obsidian seek:search query=probe limit=1 "vault=$Vault"
        Log "  search=$(($search -split "`n" | Select-Object -First 4) -join " / ")"
        $didHydrateSearch = $true
    }

    if ($isOk -and $elapsed -gt 8) {
        Log "Idle (uiHealth ok) - generating logging report"
        break
    }

    Start-Sleep -Seconds 2
}

Log "Generate logging report"
$rep = Run-Obsidian eval "vault=$Vault" 'code=app.plugins.plugins.seek.openLoggingReport().then(()=>"ok")'
Log "  report=$(Parse-Eval $rep)"

Log "Console snapshot ([seek:perf])"
Run-Obsidian eval "vault=$Vault" 'code=app.plugins.plugins.seek.dumpPerfConsole()' | Out-Null
Run-Obsidian dev:console limit=150 level=info "vault=$Vault" | Out-Null
Log "Errors"
Run-Obsidian dev:errors "vault=$Vault" | Out-Null
Log "=== done ==="
