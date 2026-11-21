param([switch]$PrepareOnly)
$ErrorActionPreference = 'Stop'
$mistyRoot = Split-Path -Parent $PSScriptRoot
$mistyData = Join-Path $mistyRoot 'data\deployment\laptop-activity'
New-Item -ItemType Directory -Force -Path $mistyData | Out-Null
$mistyUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
& icacls.exe $mistyData /inheritance:r /grant:r "${mistyUser}:(OI)(CI)F" 'SYSTEM:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not restrict activity state permissions.' }
$mistyNode = (Get-Command node.exe -ErrorAction Stop).Source
function Build-MistyWindowlessHelper([string]$Source, [string]$Name) {
    $mistyVersion = (Get-FileHash -LiteralPath $Source -Algorithm SHA256).Hash.Substring(0,12).ToLowerInvariant()
    $mistyExe = Join-Path $mistyData ($Name + '-' + $mistyVersion + '.exe')
    if (!(Test-Path -LiteralPath $mistyExe)) {
        $mistyCompile = New-Object System.Diagnostics.ProcessStartInfo
        $mistyCompile.FileName = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
        $mistyCompile.Arguments = '/nologo /target:winexe /reference:System.Web.Extensions.dll /out:"' + $mistyExe + '" "' + $Source + '"'
        $mistyCompile.UseShellExecute = $false
        $mistyCompile.CreateNoWindow = $true
        $mistyCompile.RedirectStandardOutput = $true
        $mistyCompile.RedirectStandardError = $true
        $mistyCompiler = [System.Diagnostics.Process]::Start($mistyCompile)
        $mistyOutput = $mistyCompiler.StandardOutput.ReadToEnd()
        $mistyErrors = $mistyCompiler.StandardError.ReadToEnd()
        $mistyCompiler.WaitForExit()
        if ($mistyCompiler.ExitCode -ne 0) { throw ('Windowless activity helper compilation failed: ' + $mistyOutput + $mistyErrors) }
        $mistyCompiler.Dispose()
    }
    return $mistyExe
}
$mistyDesktop = Build-MistyWindowlessHelper (Join-Path $PSScriptRoot 'misty-desktop.cs') 'misty-desktop'
$mistyLauncher = Build-MistyWindowlessHelper (Join-Path $PSScriptRoot 'misty-activity-job.cs') 'misty-activity-launcher'
@{desktop=$mistyDesktop;launcher=$mistyLauncher} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $mistyData 'native-runtime.json') -Encoding UTF8
if ($PrepareOnly) { Write-Output 'Windowless activity helpers prepared; scheduled task unchanged.'; exit }
$mistyAction = New-ScheduledTaskAction -Execute $mistyLauncher -Argument ('"' + $mistyNode + '" "' + $mistyRoot + '"') -WorkingDirectory $mistyRoot
$mistyTrigger = New-ScheduledTaskTrigger -AtLogOn -User $mistyUser
$mistyPrincipal = New-ScheduledTaskPrincipal -UserId $mistyUser -LogonType Interactive -RunLevel Limited
$mistySettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
if (Get-ScheduledTask -TaskName 'Misty Laptop Activity' -ErrorAction SilentlyContinue) {
    Set-ScheduledTask -TaskName 'Misty Laptop Activity' -Action $mistyAction | Out-Null
} else {
    Register-ScheduledTask -TaskName 'Misty Laptop Activity' -Action $mistyAction -Trigger $mistyTrigger -Principal $mistyPrincipal -Settings $mistySettings -Description 'Private foreground/window and optional Chrome tab metadata to Misty over the paired SSH relay. No screenshots or input recording.' | Out-Null
}
Start-ScheduledTask -TaskName 'Misty Laptop Activity'
Write-Output 'Misty Laptop Activity installed. Existing Codex relay was left running.'
