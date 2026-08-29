# Quick G_eviction: edit one indexed note, immediate restart, wait for reconcile.
param([string]$Vault = 'Obsidian')
$ErrorActionPreference = 'Stop'
$tag = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()

$editCode = "(async()=>{const p=app.plugins.plugins.seek;const meta=await p.store.listAllMeta();const paths=[...new Set(meta.map(m=>m.note_path))].filter(x=>!x.startsWith('Seek-G'));const files=app.vault.getMarkdownFiles().filter(f=>paths.includes(f.path)).sort((a,b)=>b.stat.mtime-a.stat.mtime);const f=files[0];if(!f)return JSON.stringify({ok:false});const rec=await p.store.getFileRecord(f.path);const before=rec?.mtimeMs;await app.vault.modify(f,(await app.vault.read(f))+'\n<!-- eviction $tag -->\n');return JSON.stringify({ok:true,path:f.path,before,fileMtime:f.stat.mtime,dirty:f.stat.mtime>(before||0)});})()"

Write-Host "Edit+restart eviction test tag=$tag"
$edit = (& obsidian eval "vault=$Vault" "code=$editCode" 2>&1 | Out-String).Trim()
Write-Host $edit
if ($edit -notmatch '"ok":true') { exit 1 }

& obsidian restart "vault=$Vault" | Out-Null
$start = Get-Date
do {
    Start-Sleep -Seconds 1
    $a = (& obsidian eval "vault=$Vault" 'code=JSON.stringify({seek:!!app.plugins.plugins.seek})' 2>&1 | Out-String).Trim()
    $e = [math]::Round(((Get-Date) - $start).TotalSeconds, 1)
    Write-Host "  ${e}s $a"
} while ($e -lt 25 -and ($a -notmatch 'true'))

Write-Host 'Wait 120s for background reconcile...'
Start-Sleep -Seconds 120
& obsidian eval "vault=$Vault" 'code=app.plugins.plugins.seek.openLoggingReport().then(()=>"ok")' | Out-Null
Write-Host 'Done'
