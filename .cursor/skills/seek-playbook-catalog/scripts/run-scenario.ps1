param(
    [Parameter(Mandatory = $true)]
    [string]$Id,
    [string]$Vault = '',
    [int]$SampleIndex = 1,
    [ValidateSet('minimal', 'full')]
    [string]$FixtureSet = 'minimal',
    [switch]$AllQueryCases,
    [string]$QueryCase = '',
    [string]$Intent = ''
)

$ErrorActionPreference = 'Stop'
$skillRoot = Split-Path $PSScriptRoot -Parent
$registryPath = Join-Path $skillRoot 'playbook-scenarios.json'
$data = Get-Content $registryPath -Raw | ConvertFrom-Json
$scenario = $data.scenarios | Where-Object { $_.id -eq $Id } | Select-Object -First 1

if (-not $scenario) {
    Write-Error "Unknown scenario id: $Id"
    exit 1
}

if ($scenario.status -eq 'stub') {
    Write-Error "driver stub: scenario $Id ($($scenario.name)) has no implemented driver yet (status=stub)"
    exit 1
}

$driverRel = $scenario.driverScript
$driverPath = Join-Path $skillRoot $driverRel
if (-not (Test-Path $driverPath)) {
    Write-Error "driver missing: $driverPath"
    exit 1
}

if (-not $Vault) { $Vault = $scenario.vaultDefault }

$driverArgs = @{
    Vault       = $Vault
    SampleIndex = $SampleIndex
    FixtureSet  = $FixtureSet
}
if ($AllQueryCases) { $driverArgs['AllQueryCases'] = $true }
if ($QueryCase) { $driverArgs['QueryCase'] = $QueryCase }
if ($Intent) { $driverArgs['Intent'] = $Intent }

& $driverPath @driverArgs
exit $LASTEXITCODE
