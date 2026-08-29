param(
    [string]$Vault = 'seek-functional',
    [int]$SampleIndex = 1
)

$ErrorActionPreference = 'Stop'
$lib = Join-Path (Split-Path $PSScriptRoot -Parent) 'lib\Invoke-ObsidianCli.ps1'
$traceLib = Join-Path (Split-Path $PSScriptRoot -Parent) 'lib\Write-ScenarioTrace.ps1'
. $lib
. $traceLib

Write-Host "S7 query supersession - vault=$Vault"

$code = @'
new Promise(async (res)=>{
  const s=app.plugins.plugins.seek;
  if(!s?.orchestrator) return res(JSON.stringify({ok:false,reason:'no-seek'}));
  await s.ensureModelLoaded();
  const slowQuery='apollo launch checklist telemetry broad notes';
  const fastQuery='matthew immergut';
  const slowP=s.orchestrator.search(slowQuery,5);
  await new Promise(r=>setTimeout(r,20));
  const fastP=s.orchestrator.search(fastQuery,5);
  const [slow, fast]=await Promise.all([slowP, fastP]);
  const slowId=slow.entry?.searchId;
  const fastId=fast.entry?.searchId;
  const slowRank1=slow.results[0]?.note_path;
  const fastRank1=fast.results[0]?.note_path;
  res(JSON.stringify({
    ok: slowId!==fastId && fastRank1?.includes('Matthew Immergut'),
    slowId, fastId, slowRank1, fastRank1,
    slowCount: slow.results.length,
    fastCount: fast.results.length
  }));
})
'@ -replace "`r`n", ' '

$start = Get-Date
$raw = Invoke-ObsidianCli -Args @('eval', "vault=$Vault", "code=$code")
$elapsedMs = [math]::Round(((Get-Date) - $start).TotalMilliseconds)
$parsed = Get-ObsidianEvalResult -Output $raw | ConvertFrom-Json

Write-Host "elapsed=${elapsedMs}ms slowId=$($parsed.slowId) fastId=$($parsed.fastId) fastRank1=$($parsed.fastRank1)"

if (-not $parsed.ok) {
    Write-Error "S7 FAIL: $($parsed | ConvertTo-Json -Compress)"
    exit 1
}

$tracePath = Write-ScenarioTrace -ScenarioId 'S7' -SampleIndex $SampleIndex -Payload @{
    elapsedMs  = $elapsedMs
    slowId     = $parsed.slowId
    fastId     = $parsed.fastId
    slowRank1  = $parsed.slowRank1
    fastRank1  = $parsed.fastRank1
    gitSha     = Get-GitShaShort
    pass       = $true
}

Write-Host "Trace: $tracePath"
exit 0
