# Build and deploy the repo to the sandbox vault (vault singleton).
# Usage:
#   .\deploy-worktree-to-vault.ps1 -PathId greedy-hydrate
#   .\deploy-worktree-to-vault.ps1 -PathId compose -SkipTests
#   .\deploy-worktree-to-vault.ps1 -PathId persist-cache

param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('trace-infra', 'greedy-hydrate', 'cheap-yield', 'batch-rpc', 'burst-cap', 'persist-cache', 'compose', 'baseline')]
    [string]$PathId,
    [string]$Vault = 'plugin-sandbox-Obsidian',
    [string]$VaultPlugin = 'C:\plugin-sandbox-Obsidian\.obsidian\plugins\seek',
    [switch]$SkipTests,
    [switch]$SkipTypecheck
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..')).Path
$workDir = $repoRoot

if ($PathId -eq 'trace-infra') { $PathId = 'baseline' }

if (-not (Test-Path (Join-Path $workDir 'package.json'))) {
    throw "Repo missing package.json: $workDir"
}

Write-Host "=== deploy-worktree path=$PathId dir=$workDir ==="
Push-Location $workDir
try {
    $branch = (git rev-parse --abbrev-ref HEAD).Trim()
    $sha = (git rev-parse --short HEAD).Trim()
    Write-Host "branch=$branch sha=$sha"

    if (-not (Test-Path 'node_modules')) {
        Write-Host 'npm ci (first use)...'
        npm ci
    }

    if (-not $SkipTypecheck) {
        Write-Host 'npm run typecheck'
        npm run typecheck
    }
    if (-not $SkipTests) {
        Write-Host 'npm test'
        npm test
    }
    Write-Host 'npm run build'
    npm run build

    Copy-Item -Force main.js, manifest.json, styles.css $VaultPlugin
    $repoHash = (Get-FileHash main.js).Hash
    $vaultHash = (Get-FileHash (Join-Path $VaultPlugin 'main.js')).Hash
    if ($repoHash -ne $vaultHash) { throw 'Vault main.js hash mismatch after copy' }

    obsidian plugin:reload id=seek "vault=$Vault" | Out-Null
    Write-Host "Deployed $PathId ($sha) -> $VaultPlugin"
    Write-Host "repo hash: $repoHash"
} finally {
    Pop-Location
}
