param(
    [string]$Vault = 'seek-functional',
    [int]$SampleIndex = 1
)

$ErrorActionPreference = 'Stop'
$lib = Join-Path (Split-Path $PSScriptRoot -Parent) 'lib\Invoke-ObsidianCli.ps1'
$traceLib = Join-Path (Split-Path $PSScriptRoot -Parent) 'lib\Write-ScenarioTrace.ps1'
. $lib
. $traceLib

Write-Host "F10 rapid query cancel - vault=$Vault"

$code = @'
new Promise(async (res)=>{
  const s=app.plugins.plugins.seek;
  if(!s?.orchestrator) return res(JSON.stringify({ok:false,reason:'no-seek'}));
  await s.ensureModelLoaded();
  const queries=['xyzzyplugh','banana bread notes','matthew immergut'];
  const controllers=queries.map(()=>new AbortController());
  const t0=performance.now();
  const promises=queries.map((q,i)=>s.orchestrator.search(q,5,undefined,undefined,controllers[i].signal).catch(e=>({error:e?.name||String(e),query:q})));
  controllers[0].abort();
  controllers[1].abort();
  const results=await Promise.all(promises);
  const last=results[2];
  const aborted=results.slice(0,2).every(r=>r.error==='AbortError'||r.error?.includes?.('Abort'));
  const rank1=last.results?.[0]?.note_path;
  res(JSON.stringify({
    ok: aborted && rank1?.includes('Matthew Immergut'),
    aborted,
    lastRank1: rank1,
    errors: results.slice(0,2).map(r=>r.error),
    elapsedMs: performance.now()-t0
  }));
})
'@ -replace "`r`n", ' '

$start = Get-Date
$raw = Invoke-ObsidianCli -Args @('eval', "vault=$Vault", "code=$code")
$elapsedMs = [math]::Round(((Get-Date) - $start).TotalMilliseconds)
$parsed = Get-ObsidianEvalResult -Output $raw | ConvertFrom-Json

Write-Host "elapsed=${elapsedMs}ms aborted=$($parsed.aborted) lastRank1=$($parsed.lastRank1)"

if (-not $parsed.ok) {
    Write-Error "F10 FAIL: $($parsed | ConvertTo-Json -Compress)"
    exit 1
}

$tracePath = Write-ScenarioTrace -ScenarioId 'F10' -SampleIndex $SampleIndex -Payload @{
    elapsedMs  = $elapsedMs
    aborted    = $parsed.aborted
    lastRank1  = $parsed.lastRank1
    errors     = $parsed.errors
    gitSha     = Get-GitShaShort
    pass       = $true
}

Write-Host "Trace: $tracePath"
exit 0
