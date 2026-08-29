# Seek cold-start probe — restart-first, serial eval/search polls.
# Usage (from repo root): .\.cursor\skills\seek-cli-startup-debug\scripts\startup-probe.ps1

param(
    [string]$Vault = "Obsidian",
    [int]$MaxSeconds = 90,
    [string]$LogFile = ""
)

$ErrorActionPreference = "Continue"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..\..")).Path
if (-not $LogFile) { $LogFile = Join-Path $repoRoot ".startup-probe.log" }

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

Log "=== Seek startup probe (vault=$Vault, max=${MaxSeconds}s) ==="
Log "Clearing dev buffers"
Run-Obsidian dev:console clear "vault=$Vault" | Out-Null
Run-Obsidian dev:errors clear "vault=$Vault" | Out-Null

Log "Restarting Obsidian"
Run-Obsidian restart "vault=$Vault" | Out-Null

$start = Get-Date
Log "Polling until alive..."
do {
    Start-Sleep -Seconds 2
    $aliveOut = Run-Obsidian eval "vault=$Vault" 'code=JSON.stringify({alive:true,seek:!!app.plugins.plugins.seek})'
    $alive = Parse-Eval $aliveOut
    $elapsed = Get-Elapsed $start
    Log "  ${elapsed}s alive=$alive"
} while ($elapsed -lt 30 -and ($alive -notmatch '"seek":true'))

Log "Reattaching debugger"
Run-Obsidian dev:debug on "vault=$Vault" | Out-Null
Log "Replaying [seek:perf] ring into CDP console"
Run-Obsidian eval "vault=$Vault" 'code=app.plugins.plugins.seek.dumpPerfConsole()' | Out-Null

$gateCode = @'
(()=>{const s=app.plugins.plugins.seek;if(!s)return JSON.stringify({seek:false});const j=s.getIndexJob();return s.getIndexStats().then(st=>JSON.stringify({ver:s.manifest.version,warmPhase:s.indexWarmPhase,warmingUp:s.isIndexWarmingUp,uiHealth:s.indexUiHealth,indexHealth:s.indexHealthState,isIndexing:s.isIndexing,job:j?{done:j.done,total:j.total,remaining:Math.max(0,j.total-j.done)}:null,files:st.files,chunks:st.chunks}))})()
'@ -replace "`r`n|`n", ""

$modelCode = "app.plugins.plugins.seek.getModelStatus().then(x=>JSON.stringify({downloaded:x.downloaded,persisted:x.persisted,name:x.name}))"
$warmCode = "localStorage.getItem('seek-startup-warm')"

while ((Get-Elapsed $start) -lt $MaxSeconds) {
    Start-Sleep -Seconds 3
    $elapsed = Get-Elapsed $start

    $gate = Parse-Eval (Run-Obsidian eval "vault=$Vault" "code=$gateCode")
    $model = Parse-Eval (Run-Obsidian eval "vault=$Vault" "code=$modelCode")
    $warm = Parse-Eval (Run-Obsidian eval "vault=$Vault" "code=$warmCode")
    $search = Run-Obsidian seek:search query=probe limit=1 "vault=$Vault"
    $searchSnippet = ($search -split "`n" | Select-Object -First 3) -join " | "

    Log "--- ${elapsed}s ---"
    Log "  gate=$gate model=$model warm=$warm"
    Log "  search=$searchSnippet"
}

Log "Capturing console and errors"
Run-Obsidian eval "vault=$Vault" 'code=app.plugins.plugins.seek.dumpPerfConsole()' | Out-Null
Run-Obsidian dev:console limit=150 level=info "vault=$Vault"
Run-Obsidian dev:errors "vault=$Vault"
Log "=== Probe complete (${MaxSeconds}s window) - see $LogFile ==="
