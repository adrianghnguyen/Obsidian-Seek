# Serial Obsidian CLI helpers - one command at a time, with timeout.
# Dot-source from verify/deploy scripts. Do not run parallel obsidian CLI elsewhere.

$script:KnownVaults = @{
    'Obsidian'                 = 'C:\Obsidian'
    'plugin-sandbox-Obsidian'  = 'C:\plugin-sandbox-Obsidian'
}

function Test-ObsidianProcessRunning {
    $procs = Get-Process -Name 'Obsidian', 'Obsidian.com' -ErrorAction SilentlyContinue
    return [bool]$procs
}

function Get-ObsidianCliEvalLine {
    param([string]$Output)
    ($Output -split "`n" | Where-Object { $_ -match '^\s*=>\s*' } | ForEach-Object { $_ -replace '^\s*=>\s*', '' }) -join ''
}

function Invoke-ObsidianCliSerial {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Args,
        [int]$TimeoutSec = 15
    )

    if (-not (Get-Command obsidian -ErrorAction SilentlyContinue)) {
        throw 'obsidian CLI not on PATH'
    }

    $job = Start-Job -ScriptBlock {
        param([string[]]$CliArgs)
        $out = & obsidian @CliArgs 2>&1 | Out-String
        [pscustomobject]@{
            Output   = $out.Trim()
            ExitCode = if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } else { 0 }
        }
    } -ArgumentList (,$Args)

    $finished = Wait-Job -Job $job -Timeout $TimeoutSec
    if (-not $finished) {
        Stop-Job -Job $job -Force -ErrorAction SilentlyContinue
        Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
        throw "Obsidian CLI timed out after ${TimeoutSec}s: obsidian $($Args -join ' ')"
    }

    $result = Receive-Job -Job $job
    Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
    $combined = [string]$result.Output

    $okPattern = '(?m)^\s*=>|^(Reloaded|Enabled|Disabled|Screenshot saved):'
    if ($result.ExitCode -ne 0 -and $combined -notmatch $okPattern) {
        throw "Obsidian CLI failed (exit $($result.ExitCode)): $combined"
    }

    return $combined
}

function Test-ObsidianCliClear {
    param(
        [string]$Vault,
        [int]$TimeoutSec = 15
    )
    try {
        $out = Invoke-ObsidianCliSerial -Args @('eval', "vault=$Vault", "code='alive'") -TimeoutSec $TimeoutSec
        $line = Get-ObsidianCliEvalLine -Output $out
        return [bool]($line -match 'alive')
    } catch {
        return $false
    }
}

function Assert-ObsidianCliReady {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Vault,
        [int]$TimeoutSec = 15
    )

    if (-not (Test-ObsidianProcessRunning)) {
        throw @(
            'Obsidian is not running.',
            'Use Ensure-ObsidianVaultReady to launch, or start Obsidian manually.',
            'Do not queue more CLI commands while the app is down.'
        ) -join ' '
    }

    if (-not (Test-ObsidianCliClear -Vault $Vault -TimeoutSec $TimeoutSec)) {
        throw @(
            'Obsidian CLI did not respond (queue wedged or vault not loaded).',
            'Quit Obsidian from the tray (Quit - not just close a window), reopen, then re-run.',
            'Do not chain obsidian restart/eval while hung - it will not reach the app.'
        ) -join ' '
    }
}

# Launch Obsidian if needed, open the target vault, poll until CLI responds.
function Ensure-ObsidianVaultReady {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Vault,
        [int]$CliTimeoutSec = 15,
        [int]$LaunchWaitSec = 120,
        [int]$PollSec = 5,
        [switch]$NoLaunch
    )

    if (Test-ObsidianCliClear -Vault $Vault -TimeoutSec $CliTimeoutSec) {
        Write-Host '      Obsidian running, CLI clear'
        return
    }

    if (-not (Test-ObsidianProcessRunning)) {
        if ($NoLaunch) {
            throw 'Obsidian is not running and -NoLaunch was set.'
        }
        Write-Host "      Obsidian not running - launching vault=$Vault via URI..."
        Open-ObsidianVault -Vault $Vault -WaitSec 0
    } else {
        Write-Host "      Obsidian running but CLI not ready - opening vault=$Vault..."
        Open-ObsidianVault -Vault $Vault -WaitSec 0
    }

    $deadline = (Get-Date).AddSeconds($LaunchWaitSec)
    do {
        Start-Sleep -Seconds $PollSec
        if (-not (Test-ObsidianProcessRunning)) {
            Write-Host '      waiting for Obsidian process...'
            continue
        }
        if (Test-ObsidianCliClear -Vault $Vault -TimeoutSec $CliTimeoutSec) {
            Write-Host '      Obsidian up, CLI alive'
            return
        }
        Write-Host '      waiting for CLI...'
    } while ((Get-Date) -lt $deadline)

    throw "Obsidian did not become CLI-ready within ${LaunchWaitSec}s for vault=$Vault (IPC may be wedged - quit Obsidian and retry)"
}

function Open-ObsidianVault {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Vault,
        [int]$WaitSec = 5
    )
    Start-Process "obsidian://open?vault=$Vault" | Out-Null
    if ($WaitSec -gt 0) { Start-Sleep -Seconds $WaitSec }
}

# Bring Obsidian to the foreground so dev:screenshot captures the app, not another window.
function Focus-ObsidianWindow {
    if (-not ('WinFocus' -as [type])) {
        Add-Type @'
using System;
using System.Runtime.InteropServices;
public class WinFocus {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
'@
    }
    $proc = Get-Process -Name 'Obsidian', 'Obsidian.com' -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } |
        Sort-Object { $_.MainWindowTitle.Length } -Descending |
        Select-Object -First 1
    if (-not $proc) {
        Write-Warning 'Could not find Obsidian main window to focus'
        return
    }
    [void][WinFocus]::ShowWindow($proc.MainWindowHandle, 9)
    [void][WinFocus]::SetForegroundWindow($proc.MainWindowHandle)
    Start-Sleep -Milliseconds 400
}

function Invoke-ObsidianEvalSerial {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Vault,
        [Parameter(Mandatory = $true)]
        [string]$Code,
        [int]$TimeoutSec = 15
    )
    $escaped = $Code -replace '"', '\"'
    $out = Invoke-ObsidianCliSerial -Args @('eval', "vault=$Vault", "code=$escaped") -TimeoutSec $TimeoutSec
    return Get-ObsidianCliEvalLine -Output $out
}

function Copy-SeekPluginArtifacts {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepoRoot,
        [Parameter(Mandatory = $true)]
        [string]$VaultPluginDir
    )
    foreach ($f in @('main.js', 'manifest.json', 'styles.css')) {
        $src = Join-Path $RepoRoot $f
        if (-not (Test-Path $src)) { throw "Missing build artifact: $src (run npm run build)" }
        Copy-Item -Force $src (Join-Path $VaultPluginDir $f)
    }
    $repoHash = (Get-FileHash (Join-Path $RepoRoot 'main.js')).Hash
    $vaultHash = (Get-FileHash (Join-Path $VaultPluginDir 'main.js')).Hash
    if ($repoHash -ne $vaultHash) { throw 'Vault main.js hash mismatch after copy' }
    return $repoHash.Substring(0, 16)
}

function Invoke-ObsidianScreenshotSerial {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Vault,
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [int]$TimeoutSec = 30
    )
    $dir = Split-Path -Parent $Path
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    Invoke-ObsidianCliSerial -Args @('dev:screenshot', "vault=$Vault", "path=$Path") -TimeoutSec $TimeoutSec | Out-Null
    if (-not (Test-Path $Path)) { throw "Screenshot not written: $Path" }
}
