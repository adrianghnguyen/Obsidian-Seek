param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('minimal', 'full')]
    [string]$FixtureSet,
    [string]$Vault = '',
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$skillRoot = Split-Path $PSScriptRoot -Parent
$fixturePath = Join-Path $skillRoot "fixtures\$FixtureSet\functional-queries.json"
$fixture = Get-Content $fixturePath -Raw | ConvertFrom-Json
if (-not $Vault) { $Vault = $fixture.vault }

function Parse-Eval([string]$Out) {
    ($Out -split "`n" | Where-Object { $_ -match '^\s*=>\s*' } | ForEach-Object { $_ -replace '^\s*=>\s*', '' }) -join ''
}

function Parse-SearchJson([string]$Out) {
    $json = Parse-Eval $Out
    if (-not $json) { return $null }
    return $json | ConvertFrom-Json -ErrorAction SilentlyContinue
}

$updated = @()
foreach ($case in $fixture.queryCases) {
    if ($case.synthetic) {
        $updated += $case
        continue
    }
    if ($case.expected.sequence) {
        $updated += $case
        continue
    }

    $q = $case.query -replace '"', '\"'
    Write-Host "seek:search query=$($case.id) ..."
    if ($DryRun) {
        $updated += $case
        continue
    }

    $out = & obsidian seek:search "vault=$Vault" "query=$q" format=json 2>&1 | Out-String
    $result = Parse-SearchJson $out
    $expected = @{}
    if ($result -and $result.results -and $result.results.Count -gt 0) {
        $expected['minCount'] = 1
        $expected['rank1Path'] = $result.results[0].path
    } elseif ($case.intent -eq 'no_answers_possible') {
        $expected['maxCount'] = 0
    } else {
        $expected['minCount'] = 0
    }
    if ($case.expected.gateBlocked) { $expected['gateBlocked'] = $true }
    if ($case.expected.nameEarlyPainted) { $expected['nameEarlyPainted'] = $true }
    if ($case.expected.rank1Contains) { $expected['rank1Contains'] = $case.expected.rank1Contains }

    $updated += [PSCustomObject]@{
        id         = $case.id
        intent     = $case.intent
        query      = $case.query
        sourcePath = $case.sourcePath
        synthetic  = $case.synthetic
        expected   = $expected
    }
    Start-Sleep -Milliseconds 500
}

if (-not $DryRun) {
    $outObj = @{
        version    = $fixture.version
        vault      = $fixture.vault
        queryCases = $updated
    }
    $outObj | ConvertTo-Json -Depth 8 | Set-Content -Path $fixturePath -Encoding UTF8
    Write-Host "Updated expected blocks in $fixturePath"
} else {
    Write-Host "Dry run — no file written"
}
