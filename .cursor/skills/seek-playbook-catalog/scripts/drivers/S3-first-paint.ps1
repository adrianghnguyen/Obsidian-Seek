param(
    [string]$Vault = 'Obsidian',
    [string]$ProbeQuery = 'notes',
    [int]$SampleIndex = 1
)

$ErrorActionPreference = 'Stop'
$lib = Join-Path (Split-Path $PSScriptRoot -Parent) 'lib\Invoke-ObsidianCli.ps1'
$traceLib = Join-Path (Split-Path $PSScriptRoot -Parent) 'lib\Write-ScenarioTrace.ps1'
. $lib
. $traceLib

Write-Host "S3 first paint - restart + first good search vault=$Vault"

Invoke-ObsidianCli -Args @('restart', "vault=$Vault") | Out-Null
$alive = ''
$bootStart = Get-Date
do {
    Start-Sleep -Seconds 1
    $alive = Invoke-ObsidianEval -Vault $Vault -Code "JSON.stringify({alive:true,seek:!!app.plugins.plugins.seek})"
    $elapsed = [math]::Round(((Get-Date) - $bootStart).TotalSeconds, 1)
    Write-Host "  ${elapsed}s $alive"
} while ($elapsed -lt 30 -and ($alive -notmatch '"seek":true'))

Invoke-ObsidianCli -Args @('dev:debug', 'on', "vault=$Vault") | Out-Null

$firstGoodMs = $null
$gateHits = @()
$overallStart = Get-Date

while (((Get-Date) - $overallStart).TotalSeconds -lt 120) {
    $gateRaw = Invoke-ObsidianEval -Vault $Vault -Code @"
(()=>{const s=app.plugins.plugins.seek;if(!s)return JSON.stringify({ready:false,reason:'no-seek'});return s.getIndexStats().then(st=>JSON.stringify({ready:s.indexWarmPhase===null&&s.indexUiHealth==='ok'&&st.chunks>0,warmPhase:s.indexWarmPhase,uiHealth:s.indexUiHealth,chunks:st.chunks}))})()
"@

    $gate = $gateRaw | ConvertFrom-Json
    $gateHits += $gate

    if ($gate.ready -and -not $firstGoodMs) {
        $searchStart = Get-Date
        $raw = Invoke-ObsidianCli -Args @('seek:search', "query=$ProbeQuery", 'format=json', "vault=$Vault")
        $searchMs = [math]::Round(((Get-Date) - $searchStart).TotalMilliseconds)
        try {
            $parsed = Get-SeekSearchJson -Output $raw
        } catch {
            $parsed = $null
        }
        $count = if ($parsed -and $null -ne $parsed.count) { [int]$parsed.count } elseif ($parsed) { @($parsed.results).Count } else { 0 }
        if ($count -ge 1 -and -not $parsed.error) {
            $firstGoodMs = [math]::Round(((Get-Date) - $overallStart).TotalMilliseconds)
            Write-Host "S3 first good at ${firstGoodMs}ms searchMs=$searchMs count=$count"
            break
        }
    }

    Start-Sleep -Seconds 2
}

if (-not $firstGoodMs) {
    Write-Error "S3 FAIL: no good search within 120s"
    exit 1
}

$tracePath = Write-ScenarioTrace -ScenarioId 'S3' -SampleIndex $SampleIndex -Payload @{
    T_first_good_ms = $firstGoodMs
    probeQuery      = $ProbeQuery
    gitSha          = Get-GitShaShort
    pass            = $true
}

Write-Host "Trace: $tracePath"
exit 0
