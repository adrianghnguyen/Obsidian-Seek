param(
    [string]$Vault = 'plugin-sandbox-Obsidian',
    [ValidateSet('minimal', 'full')]
    [string]$FixtureSet = 'full',
    [switch]$AllQueryCases,
    [string]$QueryCase = '',
    [string]$Intent = '',
    [int]$SampleIndex = 1
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..\..')).Path
$catalogRoot = Join-Path $repoRoot '.cursor\skills\seek-playbook-catalog'
$lib = Join-Path (Split-Path $PSScriptRoot -Parent) 'lib\Invoke-ObsidianCli.ps1'
. $lib

$fixturePath = Join-Path $catalogRoot "fixtures\$FixtureSet\functional-queries.json"
if (-not (Test-Path $fixturePath)) {
    Write-Error "Fixture not found: $fixturePath"
    exit 1
}

$fixture = Get-Content $fixturePath -Raw | ConvertFrom-Json
$cases = @($fixture.queryCases)

if ($QueryCase) {
    $cases = @($cases | Where-Object { $_.id -eq $QueryCase })
    if ($cases.Count -eq 0) { Write-Error "QueryCase not found: $QueryCase"; exit 1 }
} elseif ($Intent) {
    $cases = @($cases | Where-Object { $_.intent -eq $Intent })
    if ($cases.Count -eq 0) { Write-Error "Intent not found: $Intent"; exit 1 }
} elseif (-not $AllQueryCases) {
    Write-Error 'Specify -AllQueryCases, -QueryCase, or -Intent'
    exit 1
}

$traceDir = Join-Path $repoRoot ".cursor\functional-traces\F3"
New-Item -ItemType Directory -Force -Path $traceDir | Out-Null
$tracePath = Join-Path $traceDir "F3-$FixtureSet-sample$SampleIndex-$(Get-Date -Format 'yyyyMMdd-HHmmss').jsonl"

$failures = 0
$skipped = 0
$passed = 0

foreach ($case in $cases) {
    if ($case.expected.sequence -eq $true) {
        Write-Host "SKIP $($case.id) — sequence case (driver stub for gate/supersession)"
        $skipped++
        continue
    }

    $q = $case.query
    Write-Host "CASE $($case.id): `"$q`""
    $start = Get-Date
    $raw = Invoke-ObsidianCli -Args @('seek:search', "query=$q", 'format=json', "vault=$Vault")
    $elapsedMs = [math]::Round(((Get-Date) - $start).TotalMilliseconds)

    $line = @{
        ts         = (Get-Date).ToString('o')
        caseId     = $case.id
        intent     = $case.intent
        query      = $q
        elapsedMs  = $elapsedMs
        raw        = $raw
    }

    try {
        $parsed = Get-SeekSearchJson -Output $raw
    } catch {
        Write-Host "FAIL $($case.id): invalid JSON"
        $line.pass = $false
        $line.error = 'invalid-json'
        ($line | ConvertTo-Json -Compress -Depth 8) | Add-Content $tracePath
        $failures++
        continue
    }

    $count = if ($null -ne $parsed.count) { [int]$parsed.count } else { @($parsed.results).Count }
    $rank1 = @($parsed.results)[0]
    $rank1Path = $rank1.path

    $ok = $true
    $reasons = @()

    if ($parsed.error -and $case.expected.ready -ne $false) {
        $ok = $false
        $reasons += "error: $($parsed.error)"
    }

    if ($null -ne $case.expected.minCount -and $count -lt [int]$case.expected.minCount) {
        $ok = $false
        $reasons += "count $count < minCount $($case.expected.minCount)"
    }
    if ($null -ne $case.expected.maxCount -and $count -gt [int]$case.expected.maxCount) {
        $ok = $false
        $reasons += "count $count > maxCount $($case.expected.maxCount)"
    }
    if ($case.expected.rank1Path -and $rank1Path -ne $case.expected.rank1Path) {
        $ok = $false
        $reasons += "rank1Path $rank1Path != $($case.expected.rank1Path)"
    }
    if ($case.expected.rank1Contains -and $rank1Path -notlike "*$($case.expected.rank1Contains)*") {
        $title = $rank1.title
        if (-not ($title -like "*$($case.expected.rank1Contains)*")) {
            $ok = $false
            $reasons += "rank1 missing contains $($case.expected.rank1Contains)"
        }
    }

    $line.pass = $ok
    $line.count = $count
    $line.rank1Path = $rank1Path
    if ($reasons.Count) { $line.reasons = $reasons }

    ($line | ConvertTo-Json -Compress -Depth 8) | Add-Content $tracePath

    if ($ok) {
        Write-Host "PASS $($case.id) count=$count rank1=$rank1Path ${elapsedMs}ms"
        $passed++
    } else {
        Write-Host "FAIL $($case.id): $($reasons -join '; ')"
        $failures++
    }
}

Write-Host "F3 summary: passed=$passed failed=$failures skipped=$skipped trace=$tracePath"
if ($failures -gt 0) { exit 1 }
exit 0
