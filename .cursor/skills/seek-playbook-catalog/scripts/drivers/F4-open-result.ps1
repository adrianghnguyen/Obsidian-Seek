param(
    [string]$Vault = 'seek-functional',
    [string]$Query = 'matthew immergut',
    [string]$ExpectedPath = 'Notes/Matthew Immergut.md',
    [int]$SampleIndex = 1
)

$ErrorActionPreference = 'Stop'
$lib = Join-Path (Split-Path $PSScriptRoot -Parent) 'lib\Invoke-ObsidianCli.ps1'
$traceLib = Join-Path (Split-Path $PSScriptRoot -Parent) 'lib\Write-ScenarioTrace.ps1'
. $lib
. $traceLib

Write-Host "F4 open result - query=`"$Query`" vault=$Vault"

$start = Get-Date
$openRaw = Invoke-ObsidianCli -Args @('seek:open', "query=$Query", "vault=$Vault")
$openPath = ($openRaw -split "`n" | Where-Object { $_.Trim() -and $_ -notmatch '^\s*=>\s*$' } | Select-Object -Last 1).Trim() -replace '^\s*=>\s*', ''
$elapsedMs = [math]::Round(((Get-Date) - $start).TotalMilliseconds)

if ($openPath -match '^Seek error:') {
    Write-Error "F4 seek:open failed: $openPath"
    exit 1
}

$activeRaw = Invoke-ObsidianEval -Vault $Vault -Code "JSON.stringify(app.workspace.getActiveFile()?.path ?? null)"
$activePath = $activeRaw.Trim('"')

Write-Host "open=$openPath active=$activePath elapsed=${elapsedMs}ms"

$ok = ($openPath -eq $ExpectedPath) -and ($activePath -eq $ExpectedPath)
if (-not $ok) {
    Write-Error "F4 FAIL: expected $ExpectedPath open=$openPath active=$activePath"
    exit 1
}

$tracePath = Write-ScenarioTrace -ScenarioId 'F4' -SampleIndex $SampleIndex -Payload @{
    query       = $Query
    elapsedMs   = $elapsedMs
    openPath    = $openPath
    activePath  = $activePath
    expectedPath = $ExpectedPath
    gitSha      = Get-GitShaShort
    pass        = $true
}

Write-Host "Trace: $tracePath"
exit 0
