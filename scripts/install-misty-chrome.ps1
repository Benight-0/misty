$ErrorActionPreference = 'Stop'
$mistyRoot = Split-Path -Parent $PSScriptRoot
$mistyDir = Join-Path $mistyRoot 'data\deployment\laptop-activity\native-host'
New-Item -ItemType Directory -Force -Path $mistyDir | Out-Null
$mistyManifest = Get-Content -LiteralPath (Join-Path $mistyRoot 'chrome\misty-activity\manifest.json') -Raw | ConvertFrom-Json
$mistyHash = [System.Security.Cryptography.SHA256]::Create().ComputeHash([Convert]::FromBase64String($mistyManifest.key))
$mistyHex = -join ($mistyHash[0..15] | ForEach-Object { $_.ToString('x2') })
$mistyId = -join ($mistyHex.ToCharArray() | ForEach-Object { [char](97 + [Convert]::ToInt32([string]$_,16)) })
$mistyOrigin = 'chrome-extension://' + $mistyId + '/'
@{node=(Get-Command node.exe).Source;script=(Join-Path $PSScriptRoot 'misty-chrome-native-host.mjs');origin=$mistyOrigin} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $mistyDir 'config.json') -Encoding ascii
$mistySource = Join-Path $PSScriptRoot 'misty-chrome-launcher.cs'
$mistyVersion = (Get-FileHash -LiteralPath $mistySource -Algorithm SHA256).Hash.Substring(0,12).ToLowerInvariant()
$mistyExe = Join-Path $mistyDir ('misty-chrome-host-' + $mistyVersion + '.exe')
if (!(Test-Path -LiteralPath $mistyExe)) {
    & (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe') /nologo /target:winexe /reference:System.Web.Extensions.dll ('/out:' + $mistyExe) $mistySource
    if ($LASTEXITCODE -ne 0) { throw 'Native Chrome launcher compilation failed.' }
}
$mistyNativeManifest = Join-Path $mistyDir 'com.misty.laptop_activity.json'
@{name='com.misty.laptop_activity';description='Private Misty Chrome tab metadata';path=$mistyExe;type='stdio';allowed_origins=@($mistyOrigin)} | ConvertTo-Json | Set-Content -LiteralPath $mistyNativeManifest -Encoding ascii
$mistyRegistry = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.misty.laptop_activity'
New-Item -Path $mistyRegistry -Force | Out-Null
Set-Item -Path $mistyRegistry -Value $mistyNativeManifest
Write-Output ('Native host ready for extension ' + $mistyId)
Write-Output ('Remaining owner step: chrome://extensions -> Developer mode -> Load unpacked -> ' + (Join-Path $mistyRoot 'chrome\misty-activity'))
