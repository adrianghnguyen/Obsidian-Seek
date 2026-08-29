# Serial Obsidian CLI wrapper — parses => stdout lines from eval
function Invoke-ObsidianCli {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Args
    )
    $out = (& obsidian @Args 2>&1 | Out-String).Trim()
    return $out
}

function Get-ObsidianEvalResult {
    param([string]$Output)
    ($Output -split "`n" | Where-Object { $_ -match '^\s*=>\s*' } | ForEach-Object { $_ -replace '^\s*=>\s*', '' }) -join ''
}

function Invoke-ObsidianEval {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Vault,
        [Parameter(Mandatory = $true)]
        [string]$Code
    )
    $escaped = $Code -replace '"', '\"'
    $raw = Invoke-ObsidianCli -Args @('eval', "vault=$Vault", "code=$escaped")
    return Get-ObsidianEvalResult -Output $raw
}
