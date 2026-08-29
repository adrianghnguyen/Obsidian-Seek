# Restore depleted vault IDB from sidecar, then warm BM25 for G_eviction measurement.
param(
    [string]$Vault = 'Obsidian',
    [int]$MinChunks = 5000,
    [int]$PollSeconds = 30
)

$ErrorActionPreference = 'Stop'

$statsCode = 'app.plugins.plugins.seek.getIndexStats().then(s=>JSON.stringify({chunks:s.chunks,files:s.files}))'
$rebuildCode = 'app.plugins.plugins.seek.orchestrator.rebuildFromSidecar().then(r=>JSON.stringify({ok:true,result:r}))'
$warmCode = 'app.plugins.plugins.seek.orchestrator.warmCaches("restore-vault").then(()=>"ok")'

Write-Host "=== restore-vault-index vault=$Vault minChunks=$MinChunks ==="

$before = (& obsidian eval "vault=$Vault" "code=$statsCode" 2>&1 | Out-String).Trim()
Write-Host "Before: $before"

if ($before -match '"chunks":(\d+)' -and [int]$Matches[1] -ge $MinChunks) {
    Write-Host ('Index already populated (' + $Matches[1] + ' chunks) - skip rebuild')
} else {
    Write-Host 'Running rebuildFromSidecar (may take several minutes)...'
    $rebuild = (& obsidian eval "vault=$Vault" "code=$rebuildCode" 2>&1 | Out-String).Trim()
    Write-Host $rebuild
}

$deadline = (Get-Date).AddMinutes(15)
do {
    Start-Sleep -Seconds $PollSeconds
    $cur = (& obsidian eval "vault=$Vault" "code=$statsCode" 2>&1 | Out-String).Trim()
    Write-Host "$(Get-Date -Format 'HH:mm:ss') $cur"
    if ($cur -match '"chunks":(\d+)' -and [int]$Matches[1] -ge $MinChunks) { break }
} while ((Get-Date) -lt $deadline)

if ($cur -notmatch '"chunks":(\d+)' -or [int]$Matches[1] -lt $MinChunks) {
    Write-Host "FAIL: chunks still below $MinChunks"
    exit 1
}

Write-Host 'Warming BM25 cache...'
$warm = (& obsidian eval "vault=$Vault" "code=$warmCode" 2>&1 | Out-String).Trim()
Write-Host $warm

$bm25Code = 'app.plugins.plugins.seek.store.getBm25().then(b=>JSON.stringify({bm25:!!b}))'
$bm = (& obsidian eval "vault=$Vault" "code=$bm25Code" 2>&1 | Out-String).Trim()
Write-Host "BM25 persisted: $bm"
Write-Host 'OK - vault ready for G_eviction probe'
