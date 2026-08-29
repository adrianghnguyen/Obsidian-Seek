# Poll until vault index reaches MinChunks AND ui=ok (required before persistence restart).
param(
    [string]$Vault = 'Obsidian',
    [int]$MinChunks = 12000,
    [int]$PollSeconds = 45,
    [int]$TimeoutMinutes = 60
)

$ErrorActionPreference = 'Stop'
$code = 'code=(async()=>{const p=app.plugins.plugins.seek;const o=p.orchestrator;const c=await p.store.count();const s=await p.getIndexStats();return JSON.stringify({count:c.chunks,files:s.files,ui:p.indexUiHealth,writing:o.isWriting()});})()'
$deadline = (Get-Date).AddMinutes($TimeoutMinutes)
$last = ''
do {
    Start-Sleep -Seconds $PollSeconds
    $out = (& obsidian eval "vault=$Vault" $code 2>&1 | Out-String).Trim()
    Write-Host "$(Get-Date -Format 'HH:mm:ss') $out"
    $last = $out
    if ($out -match '"count":(\d+)' -and [int]$Matches[1] -ge $MinChunks -and $out -match '"ui":"ok"' -and $out -match '"writing":false') { break }
} while ((Get-Date) -lt $deadline)

Write-Host "POLL_DONE $last"
if ($last -notmatch '"count":(\d+)' -or [int]$Matches[1] -lt $MinChunks) { exit 1 }
if ($last -notmatch '"ui":"ok"') { Write-Host 'FAIL: ui not ok - do not restart until indexing completes'; exit 1 }
if ($last -notmatch '"writing":false') { Write-Host 'FAIL: orchestrator still writing - do not restart mid-index'; exit 1 }
exit 0
