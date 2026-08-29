param(
    [string]$Vault = 'seek-functional',
    [string]$Query = 'matthew immergut',
    [int]$SampleIndex = 1
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..\..')).Path
$lib = Join-Path (Split-Path $PSScriptRoot -Parent) 'lib\Invoke-ObsidianCli.ps1'
$traceLib = Join-Path (Split-Path $PSScriptRoot -Parent) 'lib\Write-ScenarioTrace.ps1'
. $lib
. $traceLib

$shotDir = Join-Path $repoRoot '.cursor\telemetry-screenshots\F6'
New-Item -ItemType Directory -Force -Path $shotDir | Out-Null
$shotPath = Join-Path $shotDir "F6-sample$SampleIndex-$(Get-Date -Format 'yyyyMMdd-HHmmss').png"

Write-Host "F6 modal search - vault=$Vault query=`"$Query`""

$qSafe = $Query -replace "'", "\'"
$openCode = @"
(()=>{const s=app.plugins.plugins.seek;if(!s)return JSON.stringify({ok:false,reason:'no-seek'});s.openSearchModal('$qSafe');return JSON.stringify({ok:true})})()
"@ -replace "`r`n", ' '

$start = Get-Date
$openRaw = Invoke-ObsidianEval -Vault $Vault -Code $openCode | ConvertFrom-Json
if (-not $openRaw.ok) {
    Write-Error "F6 failed to open modal: $($openRaw | ConvertTo-Json -Compress)"
    exit 1
}

Start-Sleep -Seconds 2
$domRaw = Invoke-ObsidianCli -Args @('dev:dom', 'selector=.seek-results .seek-result', 'text', "vault=$Vault")
$rowCount = @($domRaw -split "`n" | Where-Object { $_.Trim() -and $_ -notmatch '^\s*=>\s*$' }).Count
Invoke-ObsidianCli -Args @('dev:screenshot', "path=$shotPath", "vault=$Vault") | Out-Null

$closeCode = "(()=>{document.querySelector('.seek-search-modal')?.remove();return 'closed'})()"
Invoke-ObsidianEval -Vault $Vault -Code $closeCode | Out-Null

$elapsedMs = [math]::Round(((Get-Date) - $start).TotalMilliseconds)
Write-Host "elapsed=${elapsedMs}ms domRows~=$rowCount screenshot=$shotPath"

if ($rowCount -lt 1) {
    Write-Error "F6 FAIL: no result rows in modal DOM"
    exit 1
}

$tracePath = Write-ScenarioTrace -ScenarioId 'F6' -SampleIndex $SampleIndex -Payload @{
    query           = $Query
    elapsedMs       = $elapsedMs
    resultRowCount  = $rowCount
    screenshotPath  = $shotPath
    gitSha          = Get-GitShaShort
    pass            = $true
}

Write-Host "Trace: $tracePath"
exit 0
