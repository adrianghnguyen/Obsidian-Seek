param(
    [string]$Vault = 'seek-functional',
    [string]$ScratchPath = 'Seek-F7-Scratch.md',
    [string]$Query = 'matthew immergut',
    [int]$SampleIndex = 1
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..\..')).Path
$lib = Join-Path (Split-Path $PSScriptRoot -Parent) 'lib\Invoke-ObsidianCli.ps1'
$traceLib = Join-Path (Split-Path $PSScriptRoot -Parent) 'lib\Write-ScenarioTrace.ps1'
. $lib
. $traceLib

$shotDir = Join-Path $repoRoot '.cursor\telemetry-screenshots\F7'
New-Item -ItemType Directory -Force -Path $shotDir | Out-Null
$shotPath = Join-Path $shotDir "F7-sample$SampleIndex-$(Get-Date -Format 'yyyyMMdd-HHmmss').png"

Write-Host "F7 modal insert - vault=$Vault query=`"$Query`""

$qSafe = $Query -replace "'", "\'"
$pathSafe = $ScratchPath -replace "'", "\'"
$code = @"
new Promise(async (res)=>{
  const path='$pathSafe';
  const body='# F7 scratch\n\n';
  let f=app.vault.getAbstractFileByPath(path);
  if(!f) f=await app.vault.create(path,body);
  else await app.vault.modify(f,body);
  await app.workspace.openLinkText(path,'',false);
  const s=app.plugins.plugins.seek;
  if(!s) return res(JSON.stringify({ok:false,reason:'no-seek'}));
  await s.ensureModelLoaded();
  s.openSearchModal('$qSafe');
  let row=null;
  for(let i=0;i<25;i++){
    await new Promise(r=>setTimeout(r,200));
    row=document.querySelector('.seek-results .seek-result');
    if(row) break;
  }
  if(!row) return res(JSON.stringify({ok:false,reason:'no-result-row'}));
  const edit=document.querySelector('.seek-modal .seek-edit');
  if(!edit) return res(JSON.stringify({ok:false,reason:'no-query-field'}));
  edit.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',altKey:true,bubbles:true,cancelable:true}));
  await new Promise(r=>setTimeout(r,400));
  const text=app.workspace.activeLeaf?.view?.editor?.getValue?.()??'';
  res(JSON.stringify({ok:text.includes('[['),preview:text.slice(0,120)}));
})
"@ -replace "`r`n", ' '

$start = Get-Date
$raw = Invoke-ObsidianCli -Args @('eval', "vault=$Vault", "code=$code")
$parsed = Get-ObsidianEvalResult -Output $raw | ConvertFrom-Json
Invoke-ObsidianCli -Args @('dev:screenshot', "path=$shotPath", "vault=$Vault") | Out-Null
$elapsedMs = [math]::Round(((Get-Date) - $start).TotalMilliseconds)

Write-Host "elapsed=${elapsedMs}ms ok=$($parsed.ok) preview=$($parsed.preview)"

if (-not $parsed.ok) {
    Write-Error "F7 FAIL: $($parsed | ConvertTo-Json -Compress)"
    exit 1
}

$tracePath = Write-ScenarioTrace -ScenarioId 'F7' -SampleIndex $SampleIndex -Payload @{
    query          = $Query
    elapsedMs      = $elapsedMs
    screenshotPath = $shotPath
    preview        = $parsed.preview
    gitSha         = Get-GitShaShort
    pass           = $true
}

Write-Host "Trace: $tracePath"
exit 0
