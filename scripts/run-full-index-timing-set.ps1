# One Gemma full-index timing set on the index lab vault (default 500 notes).
# Usage: .\scripts\run-full-index-timing-set.ps1 -SetId B
# B = queue 1 / batch 8 (serial control)
# D = queue 10 / batch 8 (queue treatment)
# E = queue 10 / batch 4 (batch treatment)
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('B', 'D', 'E')]
    [string]$SetId,
    [string]$Vault = 'seek-index-lab-500',
    [string]$ExpectedBase = 'C:\\seek-index-lab-500',
    [int]$TimeoutSec = 1800,
    [switch]$AttachIfBusy
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$queue = if ($SetId -eq 'B') { 1 } else { 10 }
$batch = if ($SetId -eq 'E') { 4 } else { 8 }
$sampleOut = Join-Path $root ".tmp\index-load-set-$SetId.jsonl"

function Invoke-Eval([string]$Code) {
    $raw = & obsidian vault=$Vault eval code=$Code 2>&1 | Out-String
    $line = ($raw -split "`n" | Where-Object { $_ -match '^\s*=>' } | ForEach-Object { $_ -replace '^\s*=>\s*', '' } | Select-Object -First 1)
    if (-not $line) { throw "no eval => for: $Code`n$raw" }
    return $line
}

$ident = Invoke-Eval 'JSON.stringify({name:app.vault.getName(),base:app.vault.adapter.basePath})'
Write-Host "identity $ident"
$escBase = [regex]::Escape($ExpectedBase)
if ($ident -notmatch [regex]::Escape($Vault) -or $ident -notmatch $escBase) {
    throw "identity gate failed: $ident"
}

$busy = Invoke-Eval 'JSON.stringify({writing:!!app.plugins.plugins.seek.orchestrator.isWriting(),inFlight:!!app.plugins.plugins.seek.fullReindexInFlight,job:app.plugins.plugins.seek.getIndexJob()})'
Write-Host "busy $busy"
$isBusy = ($busy -match '"writing":true' -or $busy -match '"inFlight":true')
if ($isBusy -and -not $AttachIfBusy) {
    throw 'a full reindex is still running; do not start another set'
}

if (-not $isBusy) {
    $setCode = "(()=>{const s=app.plugins.plugins.seek;s.settings.embedInFlightMax=$queue;s.settings.rollingBatchMax=$batch;return s.saveSettings().then(()=>JSON.stringify({embedInFlightMax:s.settings.embedInFlightMax,rollingBatchMax:s.settings.rollingBatchMax}))})()"
    Write-Host (Invoke-Eval $setCode)
}

$sampler = Start-Process -FilePath 'powershell' -ArgumentList @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', (Join-Path $root 'scripts\sample-full-index-load.ps1'),
    '-DurationSec', "$TimeoutSec",
    '-OutFile', $sampleOut
) -PassThru -WindowStyle Hidden
Write-Host "sampler pid=$($sampler.Id) out=$sampleOut"

if (-not $isBusy) {
    Write-Host (Invoke-Eval "(()=>{void app.plugins.plugins.seek.runFullReindex({skipConfirm:true});return 'kicked'})()")
    Write-Host "set $SetId kicked queue=$queue batch=$batch - polling; do not reload"
} else {
    Write-Host "set $SetId attach-if-busy queue=$queue batch=$batch - polling; do not reload"
}

$code = '(()=>{const s=app.plugins.plugins.seek;if(!s)return JSON.stringify({seek:false});const j=s.getIndexJob();return JSON.stringify({t:Date.now(),writing:s.orchestrator.isWriting(),inFlight:!!s.fullReindexInFlight,job:j?{kind:j.kind,done:j.done,total:j.total}:null})})()'
$sawFull = $isBusy
$t0 = Get-Date
while (((Get-Date) - $t0).TotalSeconds -lt $TimeoutSec) {
    $line = Invoke-Eval $code
    Write-Host $line
    $j = $line | ConvertFrom-Json
    if ($j.job -and $j.job.kind -eq 'full') { $sawFull = $true }
    if ($sawFull -and -not $j.writing -and -not $j.inFlight -and $null -eq $j.job) {
        $elapsed = [int]((Get-Date) - $t0).TotalSeconds
        Write-Host "DONE set=$SetId elapsed=${elapsed}s"
        if ($sampler -and -not $sampler.HasExited) { Stop-Process -Id $sampler.Id -ErrorAction SilentlyContinue }
        exit 0
    }
    Start-Sleep -Seconds 10
}
Write-Host "TIMEOUT set=$SetId"
if ($sampler -and -not $sampler.HasExited) { Stop-Process -Id $sampler.Id -ErrorAction SilentlyContinue }
exit 1
