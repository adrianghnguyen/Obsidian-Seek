# G2 fixture: one note in sidecar but missing from local IDB (simulated peer delta).
# By default does NOT restart — let startup-trace-probe.ps1 -Run A do the single cold restart.
#
# Usage:
#   .\prepare-g2-fresh-id-fixture.ps1
#   .\startup-trace-probe.ps1 -Run A -PathId persist-cache-g2

param(
    [string]$Vault = 'Obsidian',
    [switch]$RestartAfter
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..')).Path

$fixtureCode = @'
(async () => {
  const p = app.plugins.plugins.seek;
  if (!p || !p.orchestrator || !p.store) return JSON.stringify({ ok: false, reason: 'no-seek' });
  const tag = Date.now();
  const path = 'Seek-G2-Fixture-' + tag + '.md';
  const body = '# G2 peer-delta fixture ' + tag + '\n\n' + ('unique-token-' + tag + ' ').repeat(80);
  const f = await app.vault.create(path, body);
  await p.prewarmModel();
  const r = await p.orchestrator.reindexDelta([path], [], { embed: true, maxFiles: 1 });
  const chunkIds = (await p.store.listAllMeta()).filter(m => m.note_path === path).map(m => m.chunk_id);
  if (chunkIds.length === 0) return JSON.stringify({ ok: false, reason: 'no-chunks-after-embed', path });
  const removed = await p.store.deleteFile(path);
  const after = (await p.store.listAllMeta()).filter(m => m.note_path === path).map(m => m.chunk_id);
  const sigKey = 'seek:reconcile-sig:' + p.store.dbName;
  try { app.saveLocalStorage(sigKey, 'g2-force-' + tag); } catch (_) {}
  return JSON.stringify({
    ok: true,
    path,
    tag,
    chunkIds,
    removedChunks: removed.length,
    idbChunksAfterDelete: after.length,
    embedded: r.embedded ? r.embedded.files : 0
  });
})()
'@ -replace "`r`n", ' '

Write-Host "=== prepare-g2-fresh-id-fixture vault=$Vault ==="
$out = (& obsidian eval "vault=$Vault" "code=$fixtureCode" 2>&1 | Out-String).Trim()
Write-Host $out
if ($out -notmatch '"ok":true') {
    Write-Host 'FAIL: fixture did not apply'
    exit 1
}

if ($RestartAfter) {
    Write-Host 'Restarting immediately (legacy — prefer probe Run A for the cold restart)...'
    & obsidian restart "vault=$Vault" | Out-Null
    $alive = ''
    $start = Get-Date
    do {
        Start-Sleep -Seconds 1
        $alive = (& obsidian eval "vault=$Vault" 'code=JSON.stringify({alive:true,seek:!!app.plugins.plugins.seek})' 2>&1 | Out-String).Trim()
        $elapsed = [math]::Round(((Get-Date) - $start).TotalSeconds, 1)
        Write-Host "  ${elapsed}s $alive"
    } while ($elapsed -lt 30 -and ($alive -notmatch '"seek":true'))
}

Write-Host 'OK — run: startup-trace-probe.ps1 -Run A -PathId persist-cache-g2'
