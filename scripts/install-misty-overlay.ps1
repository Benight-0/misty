param([switch]$BuildOnly)
$ErrorActionPreference = 'Stop'
$mistyRoot = Split-Path -Parent $PSScriptRoot
$project = Join-Path $mistyRoot 'desktop\Misty.Overlay\Misty.Overlay.csproj'
$releases = Join-Path $mistyRoot 'data\deployment\misty-overlay-releases'
$install = Join-Path $releases (Get-Date -Format 'yyyyMMdd-HHmmssfff')
New-Item -ItemType Directory -Path $install -Force | Out-Null
& dotnet publish $project -c Release -r win-x64 --self-contained false -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -o $install
if ($LASTEXITCODE -ne 0) { throw 'Misty overlay publish failed.' }
$executable = Join-Path $install 'Misty.Overlay.exe'
if (!(Test-Path -LiteralPath $executable)) { throw 'Published Misty overlay executable is missing.' }
if ($BuildOnly) { Write-Output $executable; return }
$previous = Get-ScheduledTask -TaskName 'Misty Overlay' -ErrorAction SilentlyContinue
$previousExecutable = if ($previous) { $previous.Actions.Execute } else { $null }
if ($previous -and $previous.State -eq 'Running') {
    Stop-ScheduledTask -TaskName 'Misty Overlay'
    $deadline = (Get-Date).AddSeconds(15)
    while ((Get-ScheduledTask -TaskName 'Misty Overlay').State -eq 'Running' -and (Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 300
    }
    if ((Get-ScheduledTask -TaskName 'Misty Overlay').State -eq 'Running') { throw 'The previous Misty overlay did not stop.' }
}
$mistyUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute $executable -WorkingDirectory $install
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $mistyUser
$principal = New-ScheduledTaskPrincipal -UserId $mistyUser -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 99 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
try {
    Register-ScheduledTask -TaskName 'Misty Overlay' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Native Misty inbox, approvals, owner conversation, Codex and VM status.' -Force | Out-Null
    Start-ScheduledTask -TaskName 'Misty Overlay'
    $deadline = (Get-Date).AddSeconds(20)
    do {
        $started = Get-CimInstance Win32_Process -Filter "name = 'Misty.Overlay.exe'" |
            Where-Object { $_.ExecutablePath -eq $executable }
        if ($started) { break }
        Start-Sleep -Milliseconds 400
    } while ((Get-Date) -lt $deadline)
    if (!$started) { throw 'The updated Misty overlay did not start.' }
} catch {
    if ($previousExecutable -and (Test-Path -LiteralPath $previousExecutable)) {
        $restore = New-ScheduledTaskAction -Execute $previousExecutable -WorkingDirectory (Split-Path -Parent $previousExecutable)
        Register-ScheduledTask -TaskName 'Misty Overlay' -Action $restore -Trigger $trigger -Principal $principal -Settings $settings -Description 'Misty overlay (restored after failed update).' -Force | Out-Null
        Start-ScheduledTask -TaskName 'Misty Overlay'
    }
    throw
}
Write-Output "Misty Overlay installed and started: $executable"
