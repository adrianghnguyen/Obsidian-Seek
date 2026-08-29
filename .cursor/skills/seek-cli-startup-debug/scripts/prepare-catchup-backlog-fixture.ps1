# Stamp all file records mtime=0 and drop contentHash → ~4k dirty for G_catchup_ux.
param([string]$Vault = 'Obsidian')
$ErrorActionPreference = 'Stop'
$code = @'
(async()=>{
  const p=app.plugins.plugins.seek;
  if(!p||!p.store)return JSON.stringify({ok:false,reason:'no-seek'});
  const dbName=p.store.dbName;
  const db=await new Promise((res,rej)=>{const r=indexedDB.open(dbName);r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)});
  const storeName='files';
  const recs=await new Promise((res,rej)=>{const tx=db.transaction(storeName,'readonly');const rq=tx.objectStore(storeName).getAll();rq.onsuccess=()=>res(rq.result);rq.onerror=()=>rej(rq.error)});
  await new Promise((res,rej)=>{
    const tx=db.transaction(storeName,'readwrite');
    const store=tx.objectStore(storeName);
    for(const rec of recs){
      const next={note_path:rec.note_path,mtimeMs:0,chunk_ids:rec.chunk_ids};
      store.put(next);
    }
    tx.oncomplete=()=>res(null);
    tx.onerror=()=>rej(tx.error);
  });
  return JSON.stringify({ok:true,staleRecords:recs.length,chunks:(await p.store.count()).chunks});
})()
'@ -replace "`r`n",' '
$out = (& obsidian eval "vault=$Vault" "code=$code" 2>&1 | Out-String).Trim()
Write-Host $out
if ($out -notmatch '"ok":true') { exit 1 }
