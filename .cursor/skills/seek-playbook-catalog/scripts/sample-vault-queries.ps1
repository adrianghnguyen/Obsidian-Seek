param(
    [Parameter(Mandatory = $true)]
    [string]$Vault,
    [int]$SampleFiles = 60,
    [int]$Seed = 42,
    [string]$Out = ''
)

$ErrorActionPreference = 'Stop'
$skillRoot = Split-Path $PSScriptRoot -Parent
if (-not $Out) {
    $Out = Join-Path $skillRoot 'fixtures\generated\query-candidates.json'
}

function Get-Rng([int]$Seed) {
    return [System.Random]::new($Seed)
}

function Parse-Eval([string]$Out) {
    ($Out -split "`n" | Where-Object { $_ -match '^\s*=>\s*' } | ForEach-Object { $_ -replace '^\s*=>\s*', '' }) -join ''
}

Write-Host "Sampling vault $Vault (files=$SampleFiles seed=$Seed)..."

$listCode = @'
(()=>{const files=app.vault.getMarkdownFiles().map(f=>f.path);return JSON.stringify(files)})()
'@ -replace "`r`n|`n", ''

$raw = Parse-Eval (& obsidian eval "vault=$Vault" "code=$listCode" 2>&1 | Out-String)
$paths = @($raw | ConvertFrom-Json)
if ($paths.Count -eq 0) {
    Write-Error "No markdown files returned from vault $Vault"
    exit 1
}

$rng = Get-Rng $Seed
$sampleCount = [Math]::Min($SampleFiles, $paths.Count)
$sampled = @()
$pool = [System.Collections.Generic.List[string]]::new()
foreach ($p in $paths) { [void]$pool.Add($p) }
for ($i = 0; $i -lt $sampleCount; $i++) {
    $idx = $rng.Next(0, $pool.Count)
    $sampled += $pool[$idx]
    $pool.RemoveAt($idx)
}

$candidates = @()
foreach ($path in $sampled) {
    $base = [System.IO.Path]::GetFileNameWithoutExtension($path)
    $candidates += [PSCustomObject]@{
        path       = $path
        basename   = $base
        suggested  = @(
            ($base.ToLower() -replace '[^a-z0-9\s]', ' ').Trim()
        )
    }
}

$outDir = Split-Path $Out -Parent
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir -Force | Out-Null }

$result = @{
    vault      = $Vault
    seed       = $Seed
    sampled    = $sampleCount
    candidates = $candidates
}
$result | ConvertTo-Json -Depth 6 | Set-Content -Path $Out -Encoding UTF8
Write-Host "Wrote $($candidates.Count) candidates to $Out"
