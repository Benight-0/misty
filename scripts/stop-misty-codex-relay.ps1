$ErrorActionPreference = 'Stop'
Stop-ScheduledTask -TaskName 'Misty Codex Relay' -ErrorAction SilentlyContinue
$mistyRoot = Split-Path -Parent $PSScriptRoot
$mistyStatusFile = Join-Path $mistyRoot 'data\deployment\misty-relay\status.json'
if (Test-Path -LiteralPath $mistyStatusFile) {
    $mistyStatus = Get-Content -Raw -LiteralPath $mistyStatusFile | ConvertFrom-Json
    $mistyProcess = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$mistyStatus.pid)
    $mistyScript = Join-Path $PSScriptRoot 'misty-codex-relay.mjs'
    if ($mistyProcess -and $mistyProcess.Name -eq 'node.exe' -and $mistyProcess.CommandLine.IndexOf($mistyScript, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
        & taskkill.exe /PID $mistyProcess.ProcessId /T /F | Out-Null
    }
}
Write-Output 'Laptop relay stopped. The VM retains approved requests. Start-ScheduledTask -TaskName "Misty Codex Relay" restarts it.'
