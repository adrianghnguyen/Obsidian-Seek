# List all playbook scenarios from playbook-scenarios.json
param(
    [ValidateSet('table', 'json')]
    [string]$Format = 'table'
)

$ErrorActionPreference = 'Stop'
$catalogRoot = Split-Path $PSScriptRoot -Parent
$registryPath = Join-Path $catalogRoot 'playbook-scenarios.json'

if (-not (Test-Path $registryPath)) {
    Write-Error "Registry not found: $registryPath"
    exit 1
}

$registry = Get-Content $registryPath -Raw | ConvertFrom-Json
$rows = @($registry.scenarios | ForEach-Object {
    [PSCustomObject]@{
        id       = $_.id
        name     = $_.name
        category = $_.category
        status   = $_.status
        mode     = $_.executionMode
        vault    = $_.vaultDefault
        driver   = $_.driverScript
    }
})

if ($Format -eq 'json') {
    $rows | ConvertTo-Json -Depth 4
} else {
    $rows | Format-Table -AutoSize id, name, category, status, mode, vault, driver
    Write-Host "`nTotal: $($rows.Count) scenarios"
}
