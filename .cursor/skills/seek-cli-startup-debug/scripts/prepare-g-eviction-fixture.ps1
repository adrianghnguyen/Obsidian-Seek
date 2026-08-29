# G_eviction fixture: cold memory + one dirty file at restart.
# Minimize evicts in-memory caches; edit + immediate restart beats background flush.
#
# Usage:
#   .\prepare-g-eviction-fixture.ps1

param(
    [string]$Vault = 'Obsidian',
    [int]$MinimizeSeconds = 30
)

$ErrorActionPreference = 'Stop'

$precheckCode = @'
app.plugins.plugins.seek.getIndexStats().then(s => JSON.stringify({
  ok: s.chunks > 1000,
  chunks: s.chunks,
  files: s.files,
  ui: app.plugins.plugins.seek.indexUiHealth
}))
'@ -replace "`r`n", ' '

# Phase 1: pick an already-indexed note path (recent mtime) for a tiny edit.
$pickCode = @'
(async () => {
  const p = app.plugins.plugins.seek;
  const meta = await p.store.listAllMeta();
  const byNote = new Map();
  for (const m of meta) {
    const n = byNote.get(m.note_path) || { path: m.note_path, chunks: 0, mtime: 0 };
    n.chunks++;
    byNote.set(m.note_path, n);
  }
  const files = app.vault.getMarkdownFiles()
    .filter(f => byNote.has(f.path) && !f.path.startsWith('Seek-G-Eviction-'))
    .sort((a, b) => b.stat.mtime - a.stat.mtime);
  const f = files[0];
  if (!f) return JSON.stringify({ ok: false, reason: 'no-indexed-note' });
  return JSON.stringify({ ok: true, path: f.path, mtime: f.stat.mtime, chunks: byNote.get(f.path).chunks });
})()
'@ -replace "`r`n", ' '

function Minimize-Obsidian {
    Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32 {
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
}
"@
    $p = Get-Process -Name 'Obsidian' -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $p) { return $false }
    [void][Win32]::ShowWindowAsync($p.MainWindowHandle, 6)
    return $true
}

Write-Host "=== prepare-g-eviction-fixture vault=$Vault ==="

$pre = (& obsidian eval "vault=$Vault" "code=$precheckCode" 2>&1 | Out-String).Trim()
Write-Host "Precheck: $pre"

if ($MinimizeSeconds -gt 0) {
    Write-Host "Minimizing idle vault ${MinimizeSeconds}s (memory eviction)..."
    if (Minimize-Obsidian) { Start-Sleep -Seconds $MinimizeSeconds }
}

$pick = (& obsidian eval "vault=$Vault" "code=$pickCode" 2>&1 | Out-String).Trim()
Write-Host "Pick note: $pick"
if ($pick -notmatch '"ok":true') { exit 1 }
$pathMatch = [regex]::Match($pick, '"path":"([^"]+)"')
$notePath = $pathMatch.Groups[1].Value
$tag = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()

$editCode = @"
(async () => {
  const path = '$notePath';
  const f = app.vault.getAbstractFileByPath(path);
  if (!f) return JSON.stringify({ ok: false, reason: 'missing', path });
  const tag = '$tag';
  const line = '\n\n<!-- g-eviction-edit ' + tag + ' -->\n';
  await app.vault.modify(f, (await app.vault.read(f)) + line);
  return JSON.stringify({ ok: true, path, tag, mtime: f.stat.mtime });
})()
"@ -replace "`r`n", ' '

Write-Host 'Editing note then immediate restart (before background flush)...'
$edit = (& obsidian eval "vault=$Vault" "code=$editCode" 2>&1 | Out-String).Trim()
Write-Host $edit
if ($edit -notmatch '"ok":true') { exit 1 }

& obsidian restart "vault=$Vault" | Out-Null

$start = Get-Date
do {
    Start-Sleep -Seconds 1
    $alive = (& obsidian eval "vault=$Vault" 'code=JSON.stringify({alive:true,seek:!!app.plugins.plugins.seek})' 2>&1 | Out-String).Trim()
    $elapsed = [math]::Round(((Get-Date) - $start).TotalSeconds, 1)
    Write-Host "  ${elapsed}s $alive"
} while ($elapsed -lt 30 -and ($alive -notmatch '"seek":true'))

Write-Host 'Waiting 60s for background reconcile...'
Start-Sleep -Seconds 60
& obsidian eval "vault=$Vault" 'code=app.plugins.plugins.seek.openLoggingReport().then(()=>"ok")' | Out-Null
Write-Host 'Done — parse seek-report.json'
