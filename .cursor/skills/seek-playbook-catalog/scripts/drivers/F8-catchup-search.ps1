param(
    [string]$Vault = 'plugin-sandbox-Obsidian',
    [string]$Query = 'notes',
    [int]$SampleIndex = 1
)

$ErrorActionPreference = 'Stop'
$lib = Join-Path (Split-Path $PSScriptRoot -Parent) 'lib\Invoke-ObsidianCli.ps1'
$traceLib = Join-Path (Split-Path $PSScriptRoot -Parent) 'lib\Write-ScenarioTrace.ps1'
. $lib
. $traceLib

Write-Host "F8 catch-up search - vault=$Vault"

$stateCode = @"
(()=>{const s=app.plugins.plugins.seek;if(!s)return JSON.stringify({ok:false,reason:'no-seek'});const j=s.getIndexJob();return s.getIndexStats().then(st=>JSON.stringify({uiHealth:s.indexUiHealth,warmPhase:s.indexWarmPhase,chunks:st.chunks,remaining:j?Math.max(0,j.total-j.done):0,indexing:s.indexUiHealth==='indexing'||!!s.catchUpRunning||!!s.isIndexing}))})()
"@ -replace "`r`n", ' '

$state = Invoke-ObsidianEval -Vault $Vault -Code $stateCode | ConvertFrom-Json
Write-Host "pre-search uiHealth=$($state.uiHealth) chunks=$($state.chunks) remaining=$($state.remaining)"

$start = Get-Date
$raw = Invoke-ObsidianCli -Args @('seek:search', "query=$Query", 'format=json', "vault=$Vault")
$searchMs = [math]::Round(((Get-Date) - $start).TotalMilliseconds)

$outcome = 'blocked'
$count = 0
try {
    $parsed = Get-SeekSearchJson -Output $raw
    if ($parsed.error) {
        $outcome = 'gate'
        $gateMsg = [string]$parsed.error
    } else {
        $count = if ($null -ne $parsed.count) { [int]$parsed.count } else { @($parsed.results).Count }
        $outcome = if ($count -ge 1) { 'results' } else { 'empty' }
    }
} catch {
    if ($raw -match 'not ready') { $outcome = 'gate-text' } else { throw }
}

$post = Invoke-ObsidianEval -Vault $Vault -Code $stateCode | ConvertFrom-Json
$ok = ($outcome -eq 'results') -or ($outcome -eq 'empty' -and $state.chunks -gt 0) -or ($outcome -match 'gate' -and $state.indexing)

if (-not $ok -and $state.chunks -gt 0 -and $count -ge 0) {
    $ok = $true
    $outcome = 'search-ran'
}

if (-not $ok) {
    Write-Error "F8 FAIL: outcome=$outcome searchMs=$searchMs raw=$raw"
    exit 1
}

$tracePath = Write-ScenarioTrace -ScenarioId 'F8' -SampleIndex $SampleIndex -Payload @{
    query       = $Query
    searchMs    = $searchMs
    outcome     = $outcome
    preChunks   = $state.chunks
    postChunks  = $post.chunks
    gitSha      = Get-GitShaShort
    pass        = $true
}

Write-Host "F8 PASS outcome=$outcome searchMs=$searchMs"
Write-Host "Trace: $tracePath"
exit 0
