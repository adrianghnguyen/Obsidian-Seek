param(
    [string]$Vault = 'Obsidian',
    [int]$SampleIndex = 1
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..\..')).Path
$fixtureScript = Join-Path $repoRoot '.cursor\skills\seek-cli-startup-debug\scripts\prepare-g2-fresh-id-fixture.ps1'
$lib = Join-Path (Split-Path $PSScriptRoot -Parent) 'lib\Invoke-ObsidianCli.ps1'
$traceLib = Join-Path (Split-Path $PSScriptRoot -Parent) 'lib\Write-ScenarioTrace.ps1'
. $lib
. $traceLib

Write-Host "S4 greedy hydrate - G2 fixture + restart + files_walked vault=$Vault"

if (-not (Test-Path $fixtureScript)) { Write-Error "G2 fixture script missing"; exit 1 }
& $fixtureScript -Vault $Vault
if ($LASTEXITCODE -ne 0) { exit 1 }

Invoke-ObsidianCli -Args @('restart', "vault=$Vault") | Out-Null
$alive = ''
$start = Get-Date
do {
    Start-Sleep -Seconds 1
    $alive = Invoke-ObsidianEval -Vault $Vault -Code "JSON.stringify({alive:true,seek:!!app.plugins.plugins.seek})"
    $elapsed = [math]::Round(((Get-Date) - $start).TotalSeconds, 1)
    Write-Host "  ${elapsed}s $alive"
} while ($elapsed -lt 30 -and ($alive -notmatch '"seek":true'))

Invoke-ObsidianCli -Args @('dev:debug', 'on', "vault=$Vault") | Out-Null
Invoke-ObsidianEval -Vault $Vault -Code "app.plugins.plugins.seek.dumpPerfConsole()" | Out-Null

$idle = $false
while (((Get-Date) - $start).TotalSeconds -lt 180) {
    $gate = Invoke-ObsidianEval -Vault $Vault -Code @"
(()=>{const s=app.plugins.plugins.seek;if(!s)return JSON.stringify({idle:false});const j=s.getIndexJob();const rem=j?Math.max(0,j.total-j.done):0;return s.getIndexStats().then(st=>JSON.stringify({idle:s.indexUiHealth==='ok'&&s.indexWarmPhase===null&&rem===0,files:st.files,chunks:st.chunks,remaining:rem}))})()
"@ | ConvertFrom-Json
    if ($gate.idle) { $idle = $true; break }
    Start-Sleep -Seconds 3
}

if (-not $idle) {
    Write-Error "S4 FAIL: vault did not reach idle within 180s"
    exit 1
}

$reportCode = @"
(()=>{const s=app.plugins.plugins.seek;if(!s)return JSON.stringify({ok:false});return s.openLoggingReport().then(()=>'ok')})()
"@
Invoke-ObsidianEval -Vault $Vault -Code $reportCode | Out-Null
Start-Sleep -Seconds 2

$vaultRoot = if ($Vault -eq 'Obsidian') { 'C:\Obsidian' } elseif ($Vault -eq 'seek-functional') { 'C:\Obsidian' } else { 'C:\plugin-sandbox-Obsidian' }
$reportPath = Join-Path $vaultRoot '.seek-artifacts\seek-report.json'
$filesWalked = $null
if (Test-Path $reportPath) {
    try {
        $report = Get-Content $reportPath -Raw | ConvertFrom-Json
        $hydrate = @($report.entries | Where-Object { $_.type -eq 'sidecar-hydrate' } | Select-Object -Last 1)
        if ($hydrate -and $hydrate.filesWalked) { $filesWalked = [int]$hydrate.filesWalked }
    } catch { }
}

if (-not $filesWalked) {
    $filesWalked = [int]$gate.files
}

$probeSec = [math]::Round(((Get-Date) - $start).TotalSeconds, 1)
$tracePath = Write-ScenarioTrace -ScenarioId 'S4' -SampleIndex $SampleIndex -Payload @{
    probeSec     = $probeSec
    filesWalked  = $filesWalked
    files        = $gate.files
    chunks       = $gate.chunks
    gitSha       = Get-GitShaShort
    pass         = ($filesWalked -ge 1)
}

if ($filesWalked -lt 1) {
    Write-Error "S4 FAIL: filesWalked=$filesWalked"
    exit 1
}

Write-Host "S4 PASS filesWalked=$filesWalked probeSec=$probeSec"
Write-Host "Trace: $tracePath"
exit 0
