param([switch]$PrepareOnly)
$ErrorActionPreference = 'Stop'
$mistyRoot = Split-Path -Parent $PSScriptRoot
$mistyData = Join-Path $mistyRoot 'data\deployment\laptop-tools'
New-Item -ItemType Directory -Force -Path $mistyData | Out-Null
$mistyUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
& icacls.exe $mistyData /inheritance:r /grant:r "${mistyUser}:(OI)(CI)F" 'SYSTEM:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not protect laptop work state.' }
if (!(Test-Path -LiteralPath (Join-Path $mistyData 'roots.json'))) {
    '{"scope":"all-drives"}' | Set-Content -LiteralPath (Join-Path $mistyData 'roots.json') -Encoding UTF8
}
$mistySource = Join-Path $PSScriptRoot 'misty-laptop-tools-job.cs'
$mistyVersion = (Get-FileHash -LiteralPath $mistySource -Algorithm SHA256).Hash.Substring(0,12).ToLowerInvariant()
$mistyLauncher = Join-Path $mistyData ('misty-tools-launcher-' + $mistyVersion + '.exe')
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
if ($PrepareOnly) { Write-Output 'Windowless laptop tools launcher prepared.'; exit }
$mistyNode = (Get-Command node.exe -ErrorAction Stop).Source
$mistyAction = New-ScheduledTaskAction -Execute $mistyLauncher -Argument ('"' + $mistyNode + '" "' + $mistyRoot + '"') -WorkingDirectory $mistyRoot
$mistyTrigger = New-ScheduledTaskTrigger -AtLogOn -User $mistyUser
$mistyPrincipal = New-ScheduledTaskPrincipal -UserId $mistyUser -LogonType Interactive -RunLevel Limited
$mistySettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName 'Misty Laptop Tools' -Action $mistyAction -Trigger $mistyTrigger -Principal $mistyPrincipal -Settings $mistySettings -Description 'Cline-derived laptop tools over paired SSH.' -Force | Out-Null
Start-ScheduledTask -TaskName 'Misty Laptop Tools'
Write-Output 'Misty Laptop Tools installed. Existing relay and activity tasks were left running.'
