param(
    [switch]$Json
)

$ErrorActionPreference = 'Stop'
$skillRoot = Split-Path $PSScriptRoot -Parent
$registryPath = Join-Path $skillRoot 'playbook-scenarios.json'
if (-not (Test-Path $registryPath)) {
    Write-Error "Registry not found: $registryPath"
    exit 1
}

$data = Get-Content $registryPath -Raw | ConvertFrom-Json
$rows = @()
foreach ($s in $data.scenarios) {
    $rows += [PSCustomObject]@{
        id     = $s.id
        name   = $s.name
        driver = $s.driverScript
        mode   = $s.executionMode
        status = $s.status
        vault  = $s.vaultDefault
    }
}

if ($Json) {
    $rows | ConvertTo-Json -Depth 4
} else {
    $rows | Format-Table -AutoSize id, name, driver, mode, status, vault
    Write-Host "Total: $($rows.Count) scenarios"
}
