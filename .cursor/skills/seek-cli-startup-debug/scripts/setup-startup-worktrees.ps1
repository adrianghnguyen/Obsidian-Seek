# Create isolated git worktrees for startup path measurement (T0–T6).
# Idempotent: skips trees that already exist. Main repo stays on its current branch
# (typically path/persist-cache); T4 uses the main repo path.
#
# Usage:
#   .\.cursor\skills\seek-cli-startup-debug\scripts\setup-startup-worktrees.ps1
#   .\.cursor\skills\seek-cli-startup-debug\scripts\setup-startup-worktrees.ps1 -InstallDeps

param(
    [switch]$InstallDeps,
    [string]$WorktreesRoot = 'C:\Coding_projects\Obsidian-Seek-worktrees',
    [string]$RepoRoot = ''
)

$ErrorActionPreference = 'Stop'
if (-not $RepoRoot) {
    $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..')).Path
}

$spec = @{
    'trace-infra'     = 'startup/trace-infra'
    'greedy-hydrate'  = 'path/greedy-hydrate'
    'cheap-yield'     = 'path/cheap-yield'
    'batch-rpc'       = 'path/batch-rpc'
    'burst-cap'       = 'path/burst-cap'
    'compose'         = 'path/compose'
}

New-Item -ItemType Directory -Force -Path $WorktreesRoot | Out-Null
Push-Location $RepoRoot
try {
    foreach ($name in $spec.Keys) {
        $branch = $spec[$name]
        $dest = Join-Path $WorktreesRoot $name
        if (Test-Path (Join-Path $dest '.git')) {
            Write-Host "OK  $name -> $dest (exists)"
            continue
        }
        Write-Host "ADD $name ($branch) -> $dest"
        git worktree add $dest $branch
    }
    Write-Host ''
    git worktree list
    Write-Host ''
    Write-Host "T4 persist-cache uses main repo: $RepoRoot [path/persist-cache]"
    Write-Host "Registry: $RepoRoot\.cursor\worktrees.json"

    if ($InstallDeps) {
        $dirs = @($RepoRoot) + ($spec.Keys | ForEach-Object { Join-Path $WorktreesRoot $_ })
        foreach ($dir in $dirs) {
            if (-not (Test-Path (Join-Path $dir 'package.json'))) { continue }
            Write-Host "npm ci -> $dir"
            Push-Location $dir
            try { npm ci --silent } finally { Pop-Location }
        }
    }
} finally {
    Pop-Location
}
