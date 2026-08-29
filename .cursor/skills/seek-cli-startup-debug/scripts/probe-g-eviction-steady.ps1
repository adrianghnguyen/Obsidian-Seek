# G_eviction steady-state probe: edit one note, restart, measure production catch-up delta.
# Reads delta-apply telemetry from the logger (not a manual in-eval reindexDelta).
param(
    [string]$Vault = 'Obsidian',
    [int]$WaitAfterRestart = 60,
    [int]$PollSeconds = 15,
    [int]$TimeoutMinutes = 15
)

$ErrorActionPreference = 'Stop'
$tag = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()

$pickAndEditCode = @"
(async () => {
  const p = app.plugins.plugins.seek;
  const paths = [...new Set((await p.store.listAllMeta()).map(m => m.note_path))]
    .filter(x => !x.startsWith('Seek-G-') && !x.includes('Private/2026-08-28'));
  const files = [];
  for (const f of app.vault.getMarkdownFiles().filter(f => paths.includes(f.path))) {
    try {
      const body = await app.vault.read(f);
      if (body.includes('g-evict-steady')) continue;
      files.push(f);
    } catch { /* skip */ }
  }
  files.sort((a,b)=>b.stat.mtime-a.stat.mtime);
  const f = files[0];
  if (!f) return JSON.stringify({ ok: false, reason: 'no-file' });
  const path = f.path;
  await app.vault.modify(f, (await app.vault.read(f)) + '\n<!-- g-evict-steady $tag -->\n');
  const rec = await p.store.getFileRecord(path);
  return JSON.stringify({ ok: true, path, storedMtime: rec?.mtimeMs, fileMtime: f.stat.mtime, vaultChunks: (await p.getIndexStats()).chunks });
})()
"@ -replace "`r`n", ' '

Write-Host "=== g-eviction-steady (production path) tag=$tag ==="
$edit = (& obsidian eval "vault=$Vault" "code=$pickAndEditCode" 2>&1 | Out-String).Trim()
Write-Host "Edit: $edit"
if ($edit -notmatch '"ok":true') { exit 1 }
$pathMatch = [regex]::Match($edit, '"path":"([^"]+)"')
$notePath = $pathMatch.Groups[1].Value.Replace('\', '/')

Write-Host "Restart..."
$restartAt = [DateTimeOffset]::UtcNow.ToString('o')
& obsidian restart "vault=$Vault" | Out-Null
$start = Get-Date
do {
  Start-Sleep -Seconds 2
  $a = (& obsidian eval "vault=$Vault" 'code=JSON.stringify({seek:!!app.plugins.plugins.seek})' 2>&1 | Out-String).Trim()
  $e = [math]::Round(((Get-Date) - $start).TotalSeconds, 1)
} while ($e -lt 40 -and ($a -notmatch 'true'))
Write-Host "Alive ${e}s; wait ${WaitAfterRestart}s..."
Start-Sleep -Seconds $WaitAfterRestart

$pollCode = @"
(async () => {
  const p = app.plugins.plugins.seek;
  const path = '__PATH__';
  const since = '__SINCE__';
  const c = await p.store.count();
  const s = await p.getIndexStats();
  const delta = await p.orchestrator.computeDelta();
  const dirty = delta.dirty.includes(path);
  const entries = await p.logger.readAll();
  const deltas = entries.filter(e =>
    e.type === 'delta-apply' && e.timestamp >= since
  );
  const last = deltas[deltas.length - 1] ?? null;
  return JSON.stringify({
    ok: true,
    ui: p.indexUiHealth,
    dirty,
    dirtyCount: delta.dirty.length,
    deletedCount: delta.deleted.length,
    chunkCount: c.chunks,
    fileCount: s.files,
    deltaCount: deltas.length,
    lastDelta: last,
    writing: p.orchestrator.isWriting(),
    catchUp: p.catchUpPending
  });
})()
"@
$pollCode = $pollCode.Replace('__PATH__', $notePath.Replace("'", "\'")).Replace('__SINCE__', $restartAt)

$deadline = (Get-Date).AddMinutes($TimeoutMinutes)
$lastPoll = ''
do {
  Start-Sleep -Seconds $PollSeconds
  $lastPoll = (& obsidian eval "vault=$Vault" "code=$pollCode" 2>&1 | Out-String).Trim()
  Write-Host "$(Get-Date -Format 'HH:mm:ss') $lastPoll"
  if ($lastPoll -match '"dirty":false' -and $lastPoll -match '"deltaCount":(\d+)' -and [int]$Matches[1] -gt 0) { break }
  if ($lastPoll -match '"dirty":false' -and $lastPoll -match '"ui":"ok"') { break }
} while ((Get-Date) -lt $deadline)

Write-Host "FINAL $lastPoll"
& obsidian eval "vault=$Vault" 'code=app.plugins.plugins.seek.openLoggingReport().then(()=>"ok")' | Out-Null

if ($lastPoll -match '"appliedIncrementally":true' -and $lastPoll -match '"mutexHoldMs":([\d.]+)') {
  $ms = [double]$Matches[1]
  if ($ms -le 2000) { Write-Host "VERDICT: PASS mutex ${ms}ms incremental (production catch-up)"; exit 0 }
  Write-Host "VERDICT: FAIL incremental but mutex ${ms}ms > 2000ms SLO"
  exit 1
}
if ($lastPoll -match '"fallbackReason":"([^"]+)"') {
  Write-Host "VERDICT: FAIL fallback $($Matches[1])"
  exit 1
}
if ($lastPoll -match '"chunkCount":(\d+)' -and [int]$Matches[1] -lt 1000) {
  Write-Host "VERDICT: INVALID - IDB depleted"
  exit 1
}
Write-Host "VERDICT: see FINAL output"
exit 1
