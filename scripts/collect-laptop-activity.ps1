param([switch]$Once)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -Path (Join-Path $PSScriptRoot 'misty-desktop.cs') -ReferencedAssemblies System.Web.Extensions
function Write-MistySample { [Console]::WriteLine(([MistyDesktop]::Capture() | ConvertTo-Json -Depth 6 -Compress)) }
if ($Once) { Write-MistySample; exit }
while ($null -ne ($mistyRequest = [Console]::ReadLine())) { if ($mistyRequest -eq 'sample') { Write-MistySample } }
