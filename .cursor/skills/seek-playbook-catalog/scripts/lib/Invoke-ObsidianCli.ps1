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

function Get-SeekSearchJson {
    param([string]$Output)
    $line = Get-ObsidianEvalResult -Output $Output
    if (-not $line) {
        $candidates = @($Output -split "`n" | Where-Object { $_.Trim().StartsWith('{') })
        $line = $candidates[-1]
    }
    if (-not $line) { throw "No JSON in seek:search output: $Output" }
    return $line | ConvertFrom-Json
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
