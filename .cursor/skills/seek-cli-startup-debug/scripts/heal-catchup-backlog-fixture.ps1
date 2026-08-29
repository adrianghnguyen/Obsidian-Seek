# Restore file records (mtime + contentHash) after prepare-catchup-backlog-fixture.
# Clears artificial ~4k dirty set without re-embedding the corpus.
param(
    [string]$Vault = 'Obsidian',
    [int]$MaxWaitSeconds = 180
)

$ErrorActionPreference = 'Stop'

$gateCode = '(()=>{const s=app.plugins.plugins.seek;const j=s.getIndexJob();return JSON.stringify({rem:j?Math.max(0,j.total-j.done):0,run:s.catchUpRunning,writing:s.orchestrator.isWriting()})})()'
$stopCatchUpCode = '(()=>{const p=app.plugins.plugins.seek;p.catchUpPending=false;p.catchUpRunning=false;p.orchestrator.setWarmDeferred(false);return JSON.stringify({ok:true,writing:p.orchestrator.isWriting()})})()'

$healCode = @'
(async()=>{
  function cyrb53Hex(str, seed=0){
    let h1=0xdeadbeef^seed,h2=0x41c6ce57^seed;
    for(let i=0;i<str.length;i++){
      const ch=str.charCodeAt(i);
      h1=Math.imul(h1^ch,2654435761);
      h2=Math.imul(h2^ch,1597334677);
    }
    h1=Math.imul(h1^(h1>>>16),2246822507)^Math.imul(h2^(h2>>>13),3266489909);
    h2=Math.imul(h2^(h2>>>16),2246822507)^Math.imul(h1^(h1>>>13),3266489909);
    return (2097151&h2).toString(16).padStart(6,'0')+(h1>>>0).toString(16).padStart(8,'0');
  }
  const p=app.plugins.plugins.seek;
  if(!p||!p.store)return JSON.stringify({ok:false,reason:'no-seek'});
  const dbName=p.store.dbName;
  const db=await new Promise((res,rej)=>{const r=indexedDB.open(dbName);r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)});
  const storeName='files';
  const recs=await new Promise((res,rej)=>{const tx=db.transaction(storeName,'readonly');const rq=tx.objectStore(storeName).getAll();rq.onsuccess=()=>res(rq.result);rq.onerror=()=>rej(rq.error)});
  let healed=0,missing=0;
  const updates=[];
  for(const rec of recs){
    if(rec.mtimeMs!==0&&rec.contentHash)continue;
    const file=app.vault.getAbstractFileByPath(rec.note_path);
    if(!file||file.extension!=='md'){missing++;continue;}
    let content='';
    try{content=await app.vault.cachedRead(file);}catch{missing++;continue;}
    updates.push({note_path:rec.note_path,mtimeMs:file.stat.mtime,chunk_ids:rec.chunk_ids||[],contentHash:cyrb53Hex(content)});
    healed++;
  }
  await new Promise((res,rej)=>{
    const tx=db.transaction(storeName,'readwrite');
    const store=tx.objectStore(storeName);
    for(const u of updates) store.put(u);
    tx.oncomplete=()=>res(null);
    tx.onerror=()=>rej(tx.error);
  });
  const d=await p.orchestrator.computeDelta();
  return JSON.stringify({ok:true,healed,missing,dirty:d.dirty.length,deleted:d.deleted.length});
})()
'@ -replace "`r`n",' '

function Parse-Eval([string]$Out) {
    ($Out -split "`n" | Where-Object { $_ -match '^\s*=>\s*' } | ForEach-Object { $_ -replace '^\s*=>\s*', '' }) -join ''
}

function Run-ObsidianEval([string]$Code) {
    $raw = (& obsidian eval "vault=$Vault" "code=$Code" 2>&1 | Out-String).Trim()
    return (Parse-Eval $raw)
}

function Run-Heal {
    $out = Run-ObsidianEval $healCode
    Write-Host $out
    return ($out -match '"ok":true')
}

Write-Host "=== heal-catchup-backlog-fixture vault=$Vault ==="
Write-Host 'Stopping catch-up flags (in-flight burst may still hold write lock)...'
$stop = Run-ObsidianEval $stopCatchUpCode
Write-Host "stop=$stop"

$deadline = (Get-Date).AddSeconds($MaxWaitSeconds)
$healed = $false
do {
    $gate = Run-ObsidianEval $gateCode
    Write-Host "$(Get-Date -Format 'HH:mm:ss') gate=$gate"
    if ($gate -match '"writing":false') {
        Write-Host 'Writer idle — healing stale file records...'
        if (Run-Heal) { $healed = $true; break }
    }
    Start-Sleep -Seconds 2
} while ((Get-Date) -lt $deadline)

if (-not $healed) {
    Write-Host 'FAIL: could not heal (writer never idle within timeout)'
    exit 1
}

Write-Host 'Reloading Seek...'
& obsidian plugin:reload id=seek "vault=$Vault" | Out-Null
Start-Sleep -Seconds 8
$afterCode = '(()=>{const p=app.plugins.plugins.seek;const j=p.getIndexJob();return JSON.stringify({ui:p.indexUiHealth,rem:j?Math.max(0,j.total-j.done):0,run:p.catchUpRunning,writing:p.orchestrator.isWriting()})})()'
$after = Run-ObsidianEval $afterCode
Write-Host "After reload: $after"
if ($after -match '"ui":"ok"' -and $after -match '"rem":0' -and $after -match '"writing":false') {
    Write-Host 'OK — vault idle'
    exit 0
}
Write-Host 'WARN — vault not fully idle; poll with poll-index-until-ready.ps1'
exit 0
