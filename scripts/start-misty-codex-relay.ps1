$ErrorActionPreference = 'Stop'
$mistyRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $mistyRoot
$mistyNode = (Get-Command node.exe -ErrorAction Stop).Source
& $mistyNode --disable-warning=ExperimentalWarning (Join-Path $PSScriptRoot 'misty-codex-relay.mjs')
exit $LASTEXITCODE
