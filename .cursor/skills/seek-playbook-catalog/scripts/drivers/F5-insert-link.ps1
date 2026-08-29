param(
    [string]$Vault = 'seek-functional',
    [string]$ScratchPath = 'Seek-F5-Scratch.md',
    [string]$Query = 'matthew immergut',
    [string]$ExpectedLinkContains = 'Matthew Immergut',
    [int]$SampleIndex = 1
)

$ErrorActionPreference = 'Stop'
$lib = Join-Path (Split-Path $PSScriptRoot -Parent) 'lib\Invoke-ObsidianCli.ps1'
$traceLib = Join-Path (Split-Path $PSScriptRoot -Parent) 'lib\Write-ScenarioTrace.ps1'
. $lib
. $traceLib

Write-Host "F5 insert link - query=`"$Query`" vault=$Vault"

$setupCode = @"
(async () => {
  const path = '$($ScratchPath -replace "'", "\'")';
  const body = '# F5 scratch\n\n';
  let f = app.vault.getAbstractFileByPath(path);
  if (!f) f = await app.vault.create(path, body);
  else await app.vault.modify(f, body);
  await app.workspace.openLinkText(path, '', false);
  const leaf = app.workspace.activeLeaf;
  const view = leaf?.view;
  if (!view || view.getViewType() !== 'markdown') return JSON.stringify({ ok: false, reason: 'no-markdown-view' });
  const editor = view.editor;
  editor.setCursor({ line: 1, ch: 0 });
  editor.setValue(body);
  return JSON.stringify({ ok: true, path });
})()
"@ -replace "`r`n", ' '

$setup = Invoke-ObsidianEval -Vault $Vault -Code $setupCode | ConvertFrom-Json
if (-not $setup.ok) {
    Write-Error "F5 setup failed: $($setup | ConvertTo-Json -Compress)"
    exit 1
}

$start = Get-Date
$insertRaw = Invoke-ObsidianCli -Args @('seek:insert-link', "query=$Query", "vault=$Vault")
$insertLine = ($insertRaw -split "`n" | Select-Object -Last 1).Trim() -replace '^\s*=>\s*', ''
$elapsedMs = [math]::Round(((Get-Date) - $start).TotalMilliseconds)

if ($insertLine -match '^Seek error:') {
    Write-Error "F5 seek:insert-link failed: $insertLine"
    exit 1
}

$readCode = @"
(() => {
  const view = app.workspace.activeLeaf?.view;
  if (!view || view.getViewType() !== 'markdown') return JSON.stringify({ ok: false, reason: 'no-markdown-view' });
  return JSON.stringify({ ok: true, body: view.editor.getValue() });
})()
"@ -replace "`r`n", ' '

$bodyJson = Invoke-ObsidianEval -Vault $Vault -Code $readCode | ConvertFrom-Json
if (-not $bodyJson.ok) {
    Write-Error "F5 read failed: $($bodyJson | ConvertTo-Json -Compress)"
    exit 1
}

$body = [string]$bodyJson.body
Write-Host "insert=$insertLine elapsed=${elapsedMs}ms bodyLen=$($body.Length)"

$ok = $body -like "*[[*$ExpectedLinkContains*]]*" -or $body -like "*[[$ExpectedLinkContains*]]*" -or $body -like "*[[$ExpectedLinkContains]]*"
if (-not $ok) {
    Write-Error "F5 FAIL: editor body missing link to $ExpectedLinkContains. Body: $body"
    exit 1
}

$tracePath = Write-ScenarioTrace -ScenarioId 'F5' -SampleIndex $SampleIndex -Payload @{
    query              = $Query
    elapsedMs          = $elapsedMs
    scratchPath        = $ScratchPath
    insertResult       = $insertLine
    expectedLinkContains = $ExpectedLinkContains
    gitSha             = Get-GitShaShort
    pass               = $true
}

Write-Host "Trace: $tracePath"
exit 0
