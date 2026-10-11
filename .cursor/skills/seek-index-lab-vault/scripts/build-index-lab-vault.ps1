# Build (or rebuild) a ~N-note Seek index lab vault from the 3k sandbox notes.
# Does not talk to the Obsidian CLI — safe while another vault is open.
# Default: C:\seek-index-lab-500  CLI name seek-index-lab-500
param(
    [string]$SourceVault = 'C:\plugin-sandbox-Obsidian',
    [string]$DestPath = 'C:\seek-index-lab-500',
    [string]$VaultName = 'seek-index-lab-500',
    [int]$NoteCount = 500,
    [int]$Seed = 42,
    [string]$PluginSource = '',
    [string]$RepoRoot = '',
    [ValidateSet('B', 'D', 'E', 'default')]
    [string]$InitialSet = 'B',
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
if (-not $RepoRoot) {
    $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..')).Path
}
if (-not $PluginSource) {
    $wt = 'C:\Users\tilou\.cursor\worktrees\Obsidian-Seek\gemma-index-caps'
    if (Test-Path (Join-Path $wt 'main.js')) { $PluginSource = $wt }
    else { $PluginSource = $RepoRoot }
}

if ($VaultName -match 'Obsidian') {
    throw "VaultName '$VaultName' must not contain 'Obsidian' (CLI substring targeting)."
}
if (-not (Test-Path -LiteralPath $SourceVault)) { throw "Source vault missing: $SourceVault" }
foreach ($f in @('main.js', 'manifest.json', 'styles.css')) {
    $p = Join-Path $PluginSource $f
    if (-not (Test-Path -LiteralPath $p)) { throw "Plugin artifact missing: $p" }
}

if ((Test-Path -LiteralPath $DestPath) -and -not $Force) {
    throw "Dest exists: $DestPath (pass -Force to rebuild)"
}
if (Test-Path -LiteralPath $DestPath) {
    Remove-Item -LiteralPath $DestPath -Recurse -Force
}

$srcRoot = (Resolve-Path -LiteralPath $SourceVault).Path
$notes = Get-ChildItem -LiteralPath $srcRoot -Recurse -Filter *.md -File | Where-Object {
    $rel = $_.FullName.Substring($srcRoot.Length).TrimStart('\', '/')
    ($rel -notmatch '^\.obsidian(\\|/)') -and ($rel -notmatch '^\.seek') -and ($rel -notlike 'seek-report.md')
} | Sort-Object FullName

if ($notes.Count -lt $NoteCount) {
    throw "Source has $($notes.Count) notes; need $NoteCount"
}

# Stable stride sample so folders stay mixed (not the first 500 alphabetically).
$stride = [math]::Max(1, [int][math]::Floor($notes.Count / $NoteCount))
$picked = New-Object System.Collections.Generic.List[System.IO.FileInfo]
$rng = [System.Random]::new($Seed)
$offset = $rng.Next(0, $stride)
for ($i = $offset; $i -lt $notes.Count -and $picked.Count -lt $NoteCount; $i += $stride) {
    [void]$picked.Add($notes[$i])
}
if ($picked.Count -lt $NoteCount) {
    foreach ($n in $notes) {
        if ($picked.Count -ge $NoteCount) { break }
        if (-not ($picked.Contains($n))) { [void]$picked.Add($n) }
    }
}

New-Item -ItemType Directory -Path $DestPath | Out-Null
$copied = 0
foreach ($n in $picked) {
    $rel = $n.FullName.Substring($srcRoot.Length).TrimStart('\', '/')
    $destFile = Join-Path $DestPath $rel
    $destDir = Split-Path -Parent $destFile
    if (-not (Test-Path -LiteralPath $destDir)) {
        New-Item -ItemType Directory -Path $destDir -Force | Out-Null
    }
    Copy-Item -LiteralPath $n.FullName -Destination $destFile -Force
    $copied++
}

$obs = Join-Path $DestPath '.obsidian'
$plug = Join-Path $obs 'plugins\seek'
New-Item -ItemType Directory -Path $plug -Force | Out-Null

$coreSrc = Join-Path $srcRoot '.obsidian\core-plugins.json'
if (Test-Path -LiteralPath $coreSrc) {
    Copy-Item -LiteralPath $coreSrc -Destination (Join-Path $obs 'core-plugins.json') -Force
}
$appSrc = Join-Path $srcRoot '.obsidian\app.json'
if (Test-Path -LiteralPath $appSrc) {
    Copy-Item -LiteralPath $appSrc -Destination (Join-Path $obs 'app.json') -Force
}
$appearSrc = Join-Path $srcRoot '.obsidian\appearance.json'
if (Test-Path -LiteralPath $appearSrc) {
    Copy-Item -LiteralPath $appearSrc -Destination (Join-Path $obs 'appearance.json') -Force
}

# Disable Sync on the lab vault (JSON rewrite).
$corePath = Join-Path $obs 'core-plugins.json'
if (Test-Path -LiteralPath $corePath) {
    $core = Get-Content -LiteralPath $corePath -Raw | ConvertFrom-Json
    $core.sync = $false
    $coreJson = $core | ConvertTo-Json -Depth 8
    [System.IO.File]::WriteAllText($corePath, $coreJson)
}

[System.IO.File]::WriteAllText(
    (Join-Path $obs 'community-plugins.json'),
    "[`n  `"seek`"`n]`n"
)
[System.IO.File]::WriteAllText((Join-Path $obs 'community-plugins-disabled.json'), "[`n]`n")

Copy-Item (Join-Path $PluginSource 'main.js') (Join-Path $plug 'main.js') -Force
Copy-Item (Join-Path $PluginSource 'manifest.json') (Join-Path $plug 'manifest.json') -Force
Copy-Item (Join-Path $PluginSource 'styles.css') (Join-Path $plug 'styles.css') -Force

$data = [ordered]@{}
$dataSrc = Join-Path $srcRoot '.obsidian\plugins\seek\data.json'
if (Test-Path -LiteralPath $dataSrc) {
    $data = Get-Content -LiteralPath $dataSrc -Raw | ConvertFrom-Json
}
$q = 10; $b = 8
if ($InitialSet -eq 'B') { $q = 1; $b = 8 }
elseif ($InitialSet -eq 'D') { $q = 10; $b = 8 }
elseif ($InitialSet -eq 'E') { $q = 10; $b = 4 }
$data | Add-Member -NotePropertyName embedInFlightMax -NotePropertyValue $q -Force
$data | Add-Member -NotePropertyName rollingBatchMax -NotePropertyValue $b -Force
$dataJson = $data | ConvertTo-Json -Depth 12
[System.IO.File]::WriteAllText((Join-Path $plug 'data.json'), $dataJson)

$readme = @"
# $VaultName

Seek index lab vault ($copied notes). Rebuilt by ``build-index-lab-vault.ps1``.
Not production. CLI: ``obsidian vault=$VaultName ...``
Identity: name=$VaultName base=$DestPath
"@
[System.IO.File]::WriteAllText((Join-Path $DestPath 'INDEX-LAB.md'), $readme)

$manifest = [ordered]@{
    vaultName     = $VaultName
    destPath      = $DestPath
    sourceVault   = $srcRoot
    noteCount     = $copied
    seed          = $Seed
    stride        = $stride
    pluginSource  = $PluginSource
    initialSet    = $InitialSet
    embedInFlightMax = $q
    rollingBatchMax  = $b
    builtAt       = (Get-Date).ToString('o')
}
$manPath = Join-Path $DestPath '.obsidian\index-lab-manifest.json'
[System.IO.File]::WriteAllText($manPath, ($manifest | ConvertTo-Json))

Write-Output "built vault=$VaultName notes=$copied path=$DestPath set=$InitialSet q=$q b=$b plugin=$PluginSource"
