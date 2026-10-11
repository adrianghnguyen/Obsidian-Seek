# Sample GPU SM% (nvidia-smi) and Obsidian process CPU% during a full reindex.
# Does not talk to the Obsidian CLI — safe to run while a reindex is in flight.
# Writes .tmp/index-load-sample.jsonl (gitignored).
param(
    [int]$IntervalSec = 1,
    [int]$DurationSec = 1800,
    [string]$OutFile = ""
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $OutFile) { $OutFile = Join-Path $root '.tmp\index-load-sample.jsonl' }
$dir = Split-Path -Parent $OutFile
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
if (Test-Path $OutFile) { Remove-Item $OutFile -Force }

function Get-ObsidianCpu {
    $procs = @(Get-Process -Name 'Obsidian' -ErrorAction SilentlyContinue)
    if ($procs.Count -eq 0) { return $null }
    $cpu = 0.0
    foreach ($p in $procs) { $cpu += $p.CPU }
    return [pscustomobject]@{ count = $procs.Count; cpuSec = [math]::Round($cpu, 3); wsMB = [math]::Round((($procs | Measure-Object WorkingSet64 -Sum).Sum / 1MB), 1) }
}

$prev = Get-ObsidianCpu
$prevAt = Get-Date
$endAt = $prevAt.AddSeconds($DurationSec)
Write-Output "sampling -> $OutFile interval=${IntervalSec}s duration=${DurationSec}s"

while ((Get-Date) -lt $endAt) {
    Start-Sleep -Seconds $IntervalSec
    $now = Get-Date
    $sm = $null
    $mem = $null
    $pwr = $null
    try {
        $nvs = nvidia-smi --query-gpu=utilization.gpu,utilization.memory,power.draw --format=csv,noheader,nounits 2>$null
        if ($nvs) {
            $parts = ($nvs | Select-Object -First 1) -split ','
            $sm = [double]$parts[0].Trim()
            $mem = [double]$parts[1].Trim()
            $pwr = [double]$parts[2].Trim()
        }
    } catch { }
    $cur = Get-ObsidianCpu
    $dt = ($now - $prevAt).TotalSeconds
    $cpuPct = $null
    if ($null -ne $prev -and $null -ne $cur -and $dt -gt 0) {
        $cores = [Environment]::ProcessorCount
        $cpuPct = [math]::Round((($cur.cpuSec - $prev.cpuSec) / $dt / $cores) * 100, 1)
        if ($cpuPct -lt 0) { $cpuPct = 0 }
    }
    $row = [ordered]@{
        t         = $now.ToString('o')
        smPct     = $sm
        memPct    = $mem
        powerW    = $pwr
        cpuPct    = $cpuPct
        obsWsMB   = if ($cur) { $cur.wsMB } else { $null }
        obsProcs  = if ($cur) { $cur.count } else { 0 }
    }
    Add-Content -Path $OutFile -Value ($row | ConvertTo-Json -Compress) -Encoding utf8
    $prev = $cur
    $prevAt = $now
}
Write-Output "done $OutFile"
