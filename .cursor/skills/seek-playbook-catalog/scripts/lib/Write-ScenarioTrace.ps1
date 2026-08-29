function Write-ScenarioTrace {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ScenarioId,
        [Parameter(Mandatory = $true)]
        [hashtable]$Payload,
        [int]$SampleIndex = 1,
        [string]$Extension = 'json'
    )
    $repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..\..')).Path
    $traceDir = Join-Path $repoRoot ".cursor\functional-traces\$ScenarioId"
    New-Item -ItemType Directory -Force -Path $traceDir | Out-Null
    $tracePath = Join-Path $traceDir "$ScenarioId-sample$SampleIndex-$(Get-Date -Format 'yyyyMMdd-HHmmss').$Extension"
    $Payload['scenarioId'] = $ScenarioId
    $Payload['sampleIndex'] = $SampleIndex
    $Payload['ts'] = (Get-Date).ToString('o')
    $Payload | ConvertTo-Json -Depth 8 | Set-Content -Path $tracePath -Encoding utf8
    return $tracePath
}

function Get-GitShaShort {
    $repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..\..')).Path
    Push-Location $repoRoot
    try { return (git rev-parse --short HEAD 2>$null) } catch { return 'unknown' }
    finally { Pop-Location }
}
