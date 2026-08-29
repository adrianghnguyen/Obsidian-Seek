# Start full vault reindexAll (await completion — ~30-45 min on large vault).
param([string]$Vault = 'Obsidian')

$ErrorActionPreference = 'Stop'
$code = '(async()=>{const p=app.plugins.plugins.seek;await p.prewarmModel();const r=await p.orchestrator.reindexAll();const c=await p.store.count();return JSON.stringify({done:true,files:r.filesIndexed,chunks:c.chunks});})()'
$out = (& obsidian eval "vault=$Vault" "code=$code" 2>&1 | Out-String).Trim()
Write-Host $out
if ($out -notmatch '"done":true') { exit 1 }
