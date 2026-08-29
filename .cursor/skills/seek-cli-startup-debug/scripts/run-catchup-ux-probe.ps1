# G_catchup_ux — atomic 4k-backlog warm-reload probe.
# Clears file records (chunks kept), reloads immediately, measures T_first_hit while remaining > 0.
#
# Usage:
#   .\run-catchup-ux-probe.ps1                    # 4k backlog (default)
#   .\run-catchup-ux-probe.ps1 -Mode small-delta  # edit one note only (protocol §6)

param(
    [ValidateSet('backlog-4k', 'small-delta')]
    [string]$Mode = 'backlog-4k',
    [string]$Vault = 'Obsidian',
    [string]$PathId = 'persist-cache',
    [int]$MaxSeconds = 600,
    [int]$FirstHitSloMs = 30000
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..')).Path
$JsonlFile = Join-Path $repoRoot '.cursor\gate-trace.jsonl'
$gitSha = ''
Push-Location $repoRoot
try { $gitSha = (git rev-parse --short HEAD 2>$null) } catch { $gitSha = 'unknown' }
finally { Pop-Location }

function Invoke-Eval([string]$Code) {
    $raw = (& obsidian eval "vault=$Vault" "code=$Code" 2>&1 | Out-String).Trim()
    return ($raw -split "`n" | Where-Object { $_ -match '^\s*=>\s*' } | ForEach-Object { $_ -replace '^\s*=>\s*', '' }) -join ''
}

function Write-Jsonl([hashtable]$Obj) {
    $line = ($Obj | ConvertTo-Json -Compress -Depth 8)
    Add-Content -Path $JsonlFile -Value $line
}

$precheckCode = @'
(()=>{const s=app.plugins.plugins.seek;if(!s)return JSON.stringify({ok:false,reason:'no-seek'});const j=s.getIndexJob();const rem=j?Math.max(0,j.total-j.done):0;return s.getIndexStats().then(st=>JSON.stringify({ok:s.indexUiHealth==='ok'&&s.indexWarmPhase===null&&rem===0&&st.chunks>=5000,uiHealth:s.indexUiHealth,warmPhase:s.indexWarmPhase,remaining:rem,chunks:st.chunks,files:st.files}))})()
'@ -replace "`r`n|`n", ''

$clearRecordsCode = @'
(async()=>{const p=app.plugins.plugins.seek;if(!p||!p.store)return JSON.stringify({ok:false,reason:'no-seek'});const dbName=p.store.dbName;const db=await new Promise((res,rej)=>{const r=indexedDB.open(dbName);r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)});const recs=await new Promise((res,rej)=>{const tx=db.transaction('files','readonly');const r=tx.objectStore('files').getAll();r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)});await new Promise((res,rej)=>{const tx=db.transaction('files','readwrite');const store=tx.objectStore('files');for(const rec of recs)store.put({note_path:rec.note_path,mtimeMs:0,chunk_ids:rec.chunk_ids});tx.oncomplete=()=>res(null);tx.onerror=()=>rej(tx.error)});return JSON.stringify({ok:true,staleRecords:recs.length,chunksKept:(await p.store.count()).chunks})})()
'@ -replace "`r`n|`n", ''

$editOneCode = @'
(async()=>{const files=app.vault.getMarkdownFiles().sort((a,b)=>b.stat.mtime-a.stat.mtime);if(!files.length)return JSON.stringify({ok:false,reason:'no-files'});const f=files[0];const body=await app.vault.read(f);await app.vault.modify(f,body+'\n');return JSON.stringify({ok:true,path:f.path})})()
'@ -replace "`r`n|`n", ''

$gateCode = @'
(()=>{const s=app.plugins.plugins.seek;if(!s)return JSON.stringify({seek:false});const j=s.getIndexJob();return s.getIndexStats().then(st=>JSON.stringify({ver:s.manifest.version,warmPhase:s.indexWarmPhase,uiHealth:s.indexUiHealth,isIndexing:s.isIndexing,catchUpRunning:!!s.catchUpRunning,job:j?{done:j.done,total:j.total,remaining:Math.max(0,j.total-j.done)}:null,files:st.files,chunks:st.chunks}))})()
'@ -replace "`r`n|`n", ''

Write-Host "=== run-catchup-ux-probe mode=$Mode path=$PathId sha=$gitSha ==="

$pre = Invoke-Eval $precheckCode
Write-Host "Precheck: $pre"
if ($pre -notmatch '"ok":true') {
    Write-Host 'FAIL: vault must be idle (ui ok, remaining 0, chunks >= 5000) before probe'
    exit 1
}

if ($Mode -eq 'backlog-4k') {
    Write-Host 'Stamping file-record mtimes to 0 (chunks + records kept)...'
    $fix = Invoke-Eval $clearRecordsCode
    Write-Host $fix
    if ($fix -notmatch '"ok":true') { exit 1 }
} else {
    Write-Host 'Editing one recent note...'
    $edit = Invoke-Eval $editOneCode
    Write-Host $edit
    if ($edit -notmatch '"ok":true') { exit 1 }
}

& obsidian dev:console clear "vault=$Vault" | Out-Null
& obsidian dev:errors clear "vault=$Vault" | Out-Null

$start = Get-Date
Write-Host 'plugin:reload (immediate — no gap after fixture)'
& obsidian plugin:reload id=seek "vault=$Vault" | Out-Null
Start-Sleep -Seconds 2
& obsidian dev:debug on "vault=$Vault" | Out-Null

$firstHitMs = $null
$drainMs = $null
$jobTotalFirst = $null

while (((Get-Date) - $start).TotalSeconds -lt $MaxSeconds) {
    $elapsedMs = [math]::Round(((Get-Date) - $start).TotalMilliseconds)
    $gateStr = Invoke-Eval $gateCode
    $gateObj = $gateStr | ConvertFrom-Json -ErrorAction SilentlyContinue
    $rem = 0
    if ($gateObj.job) { $rem = $gateObj.job.remaining }
    if ($null -eq $jobTotalFirst -and $gateObj.job -and $gateObj.job.total -gt 0) {
        $jobTotalFirst = $gateObj.job.total
    }

    $hydrateDone = $gateStr -notmatch '"warmPhase":"(starting|restoring)"' -and $gateStr -notmatch '"seek":false'
    $chunks = 0
    if ($gateObj.chunks) { $chunks = [int]$gateObj.chunks }
    $isIdleOk = $gateStr -match '"uiHealth":"ok"' -and $hydrateDone -and $rem -eq 0 -and $null -ne $jobTotalFirst

    # T_first_hit: useful search while backlog still draining (chunks already present).
    if ($null -eq $firstHitMs -and $hydrateDone -and $chunks -gt 0 -and $rem -gt 0) {
        $searchOut = (& obsidian seek:search query=probe limit=1 "vault=$Vault" 2>&1 | Out-String).Trim()
        $snippet = ($searchOut -split "`n" | Select-Object -First 4) -join ' / '
        if ($snippet -notmatch 'not ready' -and $snippet -notmatch 'not initialized' -and $snippet -match '\d\.\d') {
            $firstHitMs = $elapsedMs
            Write-Jsonl @{
                ts = (Get-Date).ToString('o'); elapsed_s = [math]::Round($elapsedMs / 1000, 2)
                run = 'warm-reload'; path_id = $PathId; git_sha = $gitSha
                event = 'first-search'; gate = $gateObj; search = $snippet
                remaining_at_hit = $rem
            }
            Write-Host "FIRST_HIT ${firstHitMs}ms remaining=$rem"
            if ($firstHitMs -le $FirstHitSloMs) {
                Write-Host "T_first_hit_ms=$firstHitMs T_drain_ms= job_total=$jobTotalFirst verdict=pass (SLO ${FirstHitSloMs}ms)"
                exit 0
            }
        }
    }

    Write-Host "--- $([math]::Round($elapsedMs/1000,1))s ui=$($gateObj.uiHealth) warm=$($gateObj.warmPhase) rem=$rem chunks=$chunks ---"

    if ($isIdleOk -and $elapsedMs -gt 5000) {
        $drainMs = $elapsedMs
        Write-Host "DRAIN_DONE ${drainMs}ms"
        break
    }

    Start-Sleep -Seconds 2
}

$verdict = 'fail'
if ($null -ne $firstHitMs -and $firstHitMs -le $FirstHitSloMs) { $verdict = 'pass' }

Write-Host "T_first_hit_ms=$firstHitMs T_drain_ms=$drainMs job_total=$jobTotalFirst verdict=$verdict (SLO ${FirstHitSloMs}ms)"

& obsidian eval "vault=$Vault" 'code=app.plugins.plugins.seek.openLoggingReport().then(()=>"ok")' | Out-Null
$dateTag = Get-Date -Format 'yyyyMMdd-HHmmss'
$scoreDir = Join-Path $repoRoot '.cursor\scorecards'
if (-not (Test-Path $scoreDir)) { New-Item -ItemType Directory -Path $scoreDir | Out-Null }
$reportSrc = Join-Path 'C:\Obsidian' '.seek-artifacts\seek-report.json'
if (Test-Path $reportSrc) {
    Copy-Item $reportSrc (Join-Path $scoreDir "$PathId-catchup-ux-$Mode-$dateTag.json") -Force
}

if ($verdict -ne 'pass') { exit 1 }
exit 0
