$ErrorActionPreference = 'Stop'
$mistyRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $mistyRoot
$mistyNode = (Get-Command node.exe -ErrorAction Stop).Source
try {
    Add-Type -Path (Join-Path $PSScriptRoot 'misty-activity-job.cs')
    exit ([MistyActivityJob]::Run($mistyNode, (Join-Path $PSScriptRoot 'misty-activity-agent.mjs'), $mistyRoot))
} catch {
    @{at=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();error=$_.Exception.Message} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $mistyRoot 'data\deployment\laptop-activity\wrapper-error.json') -Encoding UTF8
    exit 1
}
