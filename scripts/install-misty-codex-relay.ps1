param([switch]$PrepareOnly)
$ErrorActionPreference = 'Stop'
$mistyRoot = Split-Path -Parent $PSScriptRoot
$mistyData = Join-Path $mistyRoot 'data\deployment\misty-relay'
New-Item -ItemType Directory -Force -Path $mistyData | Out-Null
# A GUI-subsystem launcher avoids Windows Terminal allocation at sign-in.
$mistySource = Join-Path $PSScriptRoot 'misty-codex-relay-job.cs'
$mistyVersion = (Get-FileHash -LiteralPath $mistySource -Algorithm SHA256).Hash.Substring(0,12).ToLowerInvariant()
$mistyLauncher = Join-Path $mistyData ('misty-relay-launcher-' + $mistyVersion + '.exe')
if (!(Test-Path -LiteralPath $mistyLauncher)) {
    $mistyCompile = New-Object System.Diagnostics.ProcessStartInfo
    $mistyCompile.FileName = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
    $mistyCompile.Arguments = '/nologo /target:winexe /out:"' + $mistyLauncher + '" "' + $mistySource + '"'
    $mistyCompile.UseShellExecute = $false
    $mistyCompile.CreateNoWindow = $true
    $mistyCompile.RedirectStandardOutput = $true
    $mistyCompile.RedirectStandardError = $true
    $mistyCompiler = [System.Diagnostics.Process]::Start($mistyCompile)
    $mistyOutput = $mistyCompiler.StandardOutput.ReadToEnd()
    $mistyErrors = $mistyCompiler.StandardError.ReadToEnd()
    $mistyCompiler.WaitForExit()
    if ($mistyCompiler.ExitCode -ne 0) { throw ($mistyOutput + $mistyErrors) }
    $mistyCompiler.Dispose()
}
if ($PrepareOnly) { Write-Output $mistyLauncher; return }
$mistyConfigFile = Join-Path $mistyData 'config.json'
if (-not (Test-Path -LiteralPath $mistyConfigFile)) {
    $mistyConfig = @{
        worker = [guid]::NewGuid().ToString()
        codex = (Get-Command codex.exe -ErrorAction Stop).Source
        sshConfig = Join-Path $mistyRoot 'data\deployment\ssh_config'
    }
    $mistyConfig | ConvertTo-Json | Set-Content -LiteralPath $mistyConfigFile -Encoding utf8
}
$mistyUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
& icacls.exe $mistyData /inheritance:r /grant:r "${mistyUser}:(OI)(CI)F" 'SYSTEM:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not restrict relay state permissions.' }
$mistyNode = (Get-Command node.exe -ErrorAction Stop).Source
$mistyAction = New-ScheduledTaskAction -Execute $mistyLauncher -Argument ('"' + $mistyNode + '" "' + $mistyRoot + '"') -WorkingDirectory $mistyRoot
$mistyTrigger = New-ScheduledTaskTrigger -AtLogOn -User $mistyUser
$mistyPrincipal = New-ScheduledTaskPrincipal -UserId $mistyUser -LogonType Interactive -RunLevel Limited
$mistySettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName 'Misty Codex Relay' -Action $mistyAction -Trigger $mistyTrigger -Principal $mistyPrincipal -Settings $mistySettings -Description 'Owner-approved Misty Discord prompts to local Codex; reconnects over SSH.' -Force | Out-Null
Start-ScheduledTask -TaskName 'Misty Codex Relay'
Write-Output 'Misty relay installed and started. It starts again when this Windows account signs in.'
