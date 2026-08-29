# G_eviction targeted probe: 1 indexed note, edit, restart, restore+delta for that path only.
# Avoids whole-vault computeDelta (~85s) while measuring T4 persist-cache mutex on vault.
param([string]$Vault = 'Obsidian')

$ErrorActionPreference = 'Stop'
$tag = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$fixturePath = "Seek-G-Eviction-$tag.md"

$setupCode = @"
(async () => {
  const p = app.plugins.plugins.seek;
  const path = '$fixturePath';
  const body = '# G eviction $tag\n\n' + ('evict-$tag ').repeat(60);
  await app.vault.create(path, body);
  await p.prewarmModel();
  await p.orchestrator.reindexDelta([path], [], { embed: true, maxFiles: 1 });
  await p.orchestrator.warmCaches('g-eviction-setup');
  const chunks = (await p.store.listAllMeta()).filter(m => m.note_path === path).length;
  const bm25 = !!(await p.store.getBm25());
  return JSON.stringify({ ok: chunks > 0, path, chunks, bm25 });
})()
"@ -replace "`r`n", ' '

$probeCode = @"
(async () => {
  const p = app.plugins.plugins.seek;
  const path = '$fixturePath';
  const f = app.vault.getAbstractFileByPath(path);
  if (!f) return JSON.stringify({ ok: false, reason: 'missing' });
  const stats = await p.getIndexStats();
  const line = '\n<!-- edit $tag -->\n';
  await app.vault.modify(f, (await app.vault.read(f)) + line);
  const logs = [];
  const origInfo = console.info;
  console.info = (...a) => { logs.push(a.map(String).join(' ')); origInfo.apply(console, a); };
  const t0 = performance.now();
  const restored = await p.orchestrator.restorePersistedCachesBeforeReconcile();
  const restoreMs = Math.round(performance.now() - t0);
  const t1 = performance.now();
  const result = await p.orchestrator.reindexDelta([path], [], { embed: false, maxFiles: 1 });
  const deltaMs = Math.round(performance.now() - t1);
  console.info = origInfo;
  const fallbacks = logs.filter(l => l.includes('applyDelta fallback'));
  const o = p.orchestrator;
  const inner = o;
  const frame = inner.frameCache;
  const bm = inner.bm25Cache;
  return JSON.stringify({
    ok: true,
    vaultChunks: stats.chunks,
    restored,
    restoreMs,
    deltaMs,
    fallbacks,
    frameWarm: !!frame,
    bm25Warm: !!bm,
    frameChunks: frame?.orderedChunks?.length ?? 0,
    embedded: result?.embedded?.files ?? 0,
    incremental: fallbacks.length === 0 && !!frame && !!bm
  });
})()
"@ -replace "`r`n", ' '

Write-Host "=== G_eviction targeted probe tag=$tag ==="

Write-Host '1. Setup fixture (create + embed + warm)...'
$setup = (& obsidian eval "vault=$Vault" "code=$setupCode" 2>&1 | Out-String).Trim()
Write-Host $setup
if ($setup -notmatch '"ok":true') { exit 1 }

Write-Host '2. Cold restart...'
& obsidian restart "vault=$Vault" | Out-Null
$start = Get-Date
do {
    Start-Sleep -Seconds 1
    $a = (& obsidian eval "vault=$Vault" 'code=JSON.stringify({seek:!!app.plugins.plugins.seek})' 2>&1 | Out-String).Trim()
    $e = [math]::Round(((Get-Date) - $start).TotalSeconds, 1)
} while ($e -lt 25 -and ($a -notmatch 'true'))
Write-Host ('   alive ' + $e + 's - waiting 15s for boot gate...')
Start-Sleep -Seconds 15

Write-Host '3. Restore + 1-file delta probe...'
$probe = (& obsidian eval "vault=$Vault" "code=$probeCode" 2>&1 | Out-String).Trim()
Write-Host $probe

$gateCode = 'const p=app.plugins.plugins.seek;JSON.stringify({gate:p.indexWarmPhase,ui:p.indexUiHealth,good:p.isIndexGoodEnough})'
$gate = (& obsidian eval "vault=$Vault" "code=$gateCode" 2>&1 | Out-String).Trim()
Write-Host "Gate: $gate"

& obsidian eval "vault=$Vault" 'code=app.plugins.plugins.seek.openLoggingReport().then(()=>"ok")' | Out-Null

# Parse verdict
if ($probe -match 'incremental.:true') { $inc = $true } else { $inc = $false }
if ($probe -match 'deltaMs.:(\d+)') { $mutex = [double]$Matches[1] } else { $mutex = 99999 }
$pass = $inc -and ($mutex -le 2000)
Write-Host ""
Write-Host ('VERDICT: inc=' + $inc + ' mutex=' + $mutex + 'ms => ' + $(if ($pass) { 'PASS' } else { 'FAIL' }))
